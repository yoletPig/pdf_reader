"""论文检索与 URL 导入 API"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urljoin, urlparse, unquote
from xml.etree import ElementTree as ET

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.paper import Paper
from app.api.papers import _paper_to_dict, create_paper_from_pdf_bytes
from app.utils.text_utils import extract_arxiv_id

router = APIRouter(prefix="/api/search", tags=["论文检索"])

ARXIV_API_URL = "https://export.arxiv.org/api/query"
ARXIV_ABS_URL = "https://arxiv.org/abs/{paper_id}"
ARXIV_PDF_URL = "https://arxiv.org/pdf/{paper_id}.pdf"
HTML_PDF_META_PATTERN = re.compile(
    r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
HTML_PDF_LINK_PATTERN = re.compile(
    r'href=["\']([^"\']+\.pdf(?:\?[^"\']*)?)["\']',
    re.IGNORECASE,
)

SOCKS_PROXY_DEPENDENCY_MESSAGE = (
    "当前环境启用了 SOCKS 代理，但缺少 socksio 依赖。"
    "请安装 `httpx[socks]` 或 `socksio` 后重试。"
)


def _normalize_url(url: str) -> str:
    normalized = (url or "").strip()
    if not normalized:
        return ""
    if not re.match(r"^https?://", normalized, re.IGNORECASE):
        normalized = f"https://{normalized}"
    return normalized


def _guess_filename_from_url(url: str, fallback: str = "paper.pdf") -> str:
    path = unquote(urlparse(url).path or "")
    filename = path.rsplit("/", 1)[-1].strip()
    if not filename:
        return fallback
    if not filename.lower().endswith(".pdf"):
        filename = f"{filename}.pdf"
    return filename


def _published_year(value: str) -> Optional[int]:
    match = re.match(r"^(\d{4})-", (value or "").strip())
    return int(match.group(1)) if match else None


def _sanitize_search_abstract(text: str) -> str:
    value = (text or "").strip()
    if not value:
        return ""

    # Collapse common LaTeX link wrappers in arXiv abstracts.
    value = re.sub(
        r"\\href\{([^}]*)\}\{\\text\{([^}]*)\}\}",
        lambda match: match.group(2).strip() or match.group(1).strip(),
        value,
    )
    value = re.sub(
        r"\\href\{([^}]*)\}\{([^}]*)\}",
        lambda match: match.group(2).strip() or match.group(1).strip(),
        value,
    )
    value = re.sub(r"\\text\{([^}]*)\}", lambda match: match.group(1).strip(), value)

    # Remove lightweight inline math wrappers when they only wrap plain text / links.
    value = re.sub(r"\$([^$]+)\$", lambda match: match.group(1).strip(), value)

    replacements = {
        r"\&": "&",
        r"\%": "%",
        r"\_": "_",
        r"\#": "#",
        r"\$": "$",
        r"~": " ",
    }
    for source, target in replacements.items():
        value = value.replace(source, target)

    value = re.sub(r"\\[a-zA-Z]+\s*", " ", value)
    value = re.sub(r"\{|\}", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


async def _fetch_text(url: str, params: Optional[dict] = None) -> str:
    try:
        client = httpx.AsyncClient(timeout=20.0, follow_redirects=True)
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=SOCKS_PROXY_DEPENDENCY_MESSAGE) from exc
    async with client:
        response = await client.get(url, params=params, headers={"User-Agent": "pdf-reader/0.1"})
        response.raise_for_status()
        return response.text


def _parse_arxiv_feed(xml_text: str) -> tuple[list[dict], int]:
    root = ET.fromstring(xml_text)
    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
    }
    entries: list[dict] = []
    total_results = int(root.findtext("opensearch:totalResults", default="0", namespaces=ns) or "0")

    for entry in root.findall("atom:entry", ns):
        entry_id = (entry.findtext("atom:id", default="", namespaces=ns) or "").strip()
        title = re.sub(r"\s+", " ", entry.findtext("atom:title", default="", namespaces=ns) or "").strip()
        abstract = _sanitize_search_abstract(
            re.sub(r"\s+", " ", entry.findtext("atom:summary", default="", namespaces=ns) or "").strip()
        )
        published = (entry.findtext("atom:published", default="", namespaces=ns) or "").strip()
        authors = [
            re.sub(r"\s+", " ", author.findtext("atom:name", default="", namespaces=ns) or "").strip()
            for author in entry.findall("atom:author", ns)
        ]
        links = entry.findall("atom:link", ns)
        pdf_url = ""
        for link in links:
            href = link.attrib.get("href", "").strip()
            link_type = link.attrib.get("type", "").strip()
            if link_type == "application/pdf" or href.endswith(".pdf"):
                pdf_url = href
                break

        source_id = extract_arxiv_id(entry_id) or ""
        entries.append(
            {
                "title": title,
                "authors": [name for name in authors if name],
                "year": _published_year(published),
                "source": "arxiv",
                "source_id": source_id,
                "abstract": abstract,
                "citation_count": None,
                "url": entry_id or (ARXIV_ABS_URL.format(paper_id=source_id) if source_id else ""),
                "pdf_url": pdf_url or (ARXIV_PDF_URL.format(paper_id=source_id) if source_id else ""),
            }
        )
    return entries, total_results


async def _search_arxiv(query: str, page: int, page_size: int) -> tuple[list[dict], int]:
    xml_text = await _fetch_text(
        ARXIV_API_URL,
        params={
            "search_query": f"all:{query}",
            "start": max(0, (page - 1) * page_size),
            "max_results": max(1, min(page_size, 20)),
            "sortBy": "relevance",
            "sortOrder": "descending",
        },
    )
    return _parse_arxiv_feed(xml_text)


async def _fetch_arxiv_entry(source_id: str) -> Optional[dict]:
    xml_text = await _fetch_text(
        ARXIV_API_URL,
        params={
            "id_list": source_id,
            "start": 0,
            "max_results": 1,
        },
    )
    entries, _total = _parse_arxiv_feed(xml_text)
    return entries[0] if entries else None


async def _download_pdf_from_url(url: str) -> tuple[bytes, str]:
    try:
        client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=SOCKS_PROXY_DEPENDENCY_MESSAGE) from exc
    async with client:
        response = await client.get(url, headers={"User-Agent": "pdf-reader/0.1", "Accept": "application/pdf,text/html"})
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()
        content = response.content

        if "application/pdf" in content_type or content[:5] == b"%PDF-":
            return content, str(response.url)

        html_text = response.text
        pdf_match = HTML_PDF_META_PATTERN.search(html_text) or HTML_PDF_LINK_PATTERN.search(html_text)
        if not pdf_match:
            raise HTTPException(status_code=400, detail="未能从该 URL 解析出 PDF 下载地址")

        pdf_url = urljoin(str(response.url), pdf_match.group(1).strip())
        pdf_response = await client.get(pdf_url, headers={"User-Agent": "pdf-reader/0.1", "Accept": "application/pdf"})
        pdf_response.raise_for_status()
        pdf_content = pdf_response.content
        if pdf_content[:5] != b"%PDF-":
            raise HTTPException(status_code=400, detail="解析到的下载地址不是有效 PDF")
        return pdf_content, str(pdf_response.url)


async def _find_existing_paper(db: AsyncSession, *, source: str, source_id: str) -> Optional[Paper]:
    if not source_id:
        return None
    result = await db.execute(select(Paper).where(Paper.source == source, Paper.source_id == source_id))
    return result.scalar_one_or_none()


@router.get("")
async def search_papers(
    query: str,
    source: Optional[str] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    page: int = 1,
    page_size: int = 10,
):
    """论文搜索。当前接入 arXiv。"""
    normalized_query = (query or "").strip()
    if not normalized_query:
        raise HTTPException(status_code=400, detail="搜索关键词不能为空")

    selected_source = (source or "arxiv").lower()
    if selected_source not in {"arxiv", "all"}:
        raise HTTPException(status_code=400, detail="当前仅支持 arXiv 搜索")
    page = max(1, page)
    page_size = max(1, min(page_size, 20))

    try:
        results, total = await _search_arxiv(normalized_query, page, page_size)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"arXiv 搜索失败: {str(exc)[:200]}") from exc

    if year_from is not None:
        results = [item for item in results if item.get("year") is None or item["year"] >= year_from]
    if year_to is not None:
        results = [item for item in results if item.get("year") is None or item["year"] <= year_to]

    return {
        "query": normalized_query,
        "results": results,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/import")
async def import_paper(data: dict, db: AsyncSession = Depends(get_db)):
    """从 arXiv 搜索结果或论文 URL 自动下载 PDF 并入库。"""
    source = (data.get("source") or "").strip().lower()
    source_id = (data.get("source_id") or "").strip()
    raw_url = data.get("url") or data.get("paper_url") or ""
    normalized_url = _normalize_url(raw_url)

    try:
        if source == "arxiv" and source_id:
            existing = await _find_existing_paper(db, source="arxiv", source_id=source_id)
            if existing:
                return {"message": "论文已存在", "paper_id": existing.id, "paper": _paper_to_dict(existing)}

            entry = await _fetch_arxiv_entry(source_id)
            if not entry:
                raise HTTPException(status_code=404, detail="未找到对应的 arXiv 论文")

            pdf_content, resolved_pdf_url = await _download_pdf_from_url(entry["pdf_url"])
            paper = await create_paper_from_pdf_bytes(
                db,
                filename=_guess_filename_from_url(resolved_pdf_url, f"{source_id}.pdf"),
                content=pdf_content,
                source="arxiv",
                source_id=source_id,
                authors=entry.get("authors") or [],
                abstract=entry.get("abstract") or "",
                title=entry.get("title") or "",
                year=entry.get("year"),
                extra_pdf_metadata={
                    "entry_url": entry.get("url") or ARXIV_ABS_URL.format(paper_id=source_id),
                    "pdf_url": resolved_pdf_url,
                },
            )
            return {"message": "导入成功", "paper_id": paper["id"], "paper": paper}

        if not normalized_url:
            raise HTTPException(status_code=400, detail="请提供论文 URL 或搜索结果标识")

        arxiv_id = extract_arxiv_id(normalized_url)
        if arxiv_id:
            existing = await _find_existing_paper(db, source="arxiv", source_id=arxiv_id)
            if existing:
                return {"message": "论文已存在", "paper_id": existing.id, "paper": _paper_to_dict(existing)}
            entry = await _fetch_arxiv_entry(arxiv_id)
            if not entry:
                raise HTTPException(status_code=404, detail="未找到对应的 arXiv 论文")

            pdf_content, resolved_pdf_url = await _download_pdf_from_url(entry["pdf_url"])
            paper = await create_paper_from_pdf_bytes(
                db,
                filename=_guess_filename_from_url(resolved_pdf_url, f"{arxiv_id}.pdf"),
                content=pdf_content,
                source="arxiv",
                source_id=arxiv_id,
                authors=entry.get("authors") or [],
                abstract=entry.get("abstract") or "",
                title=entry.get("title") or "",
                year=entry.get("year"),
                extra_pdf_metadata={
                    "entry_url": entry.get("url") or normalized_url,
                    "pdf_url": resolved_pdf_url,
                    "import_url": normalized_url,
                },
            )
            return {"message": "导入成功", "paper_id": paper["id"], "paper": paper}

        existing = await _find_existing_paper(db, source="url", source_id=normalized_url)
        if existing:
            return {"message": "论文已存在", "paper_id": existing.id, "paper": _paper_to_dict(existing)}

        pdf_content, resolved_pdf_url = await _download_pdf_from_url(normalized_url)
        paper = await create_paper_from_pdf_bytes(
            db,
            filename=_guess_filename_from_url(resolved_pdf_url),
            content=pdf_content,
            source="url",
            source_id=normalized_url,
            extra_pdf_metadata={
                "import_url": normalized_url,
                "resolved_pdf_url": resolved_pdf_url,
            },
        )
        return {"message": "导入成功", "paper_id": paper["id"], "paper": paper}
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"下载论文失败: {str(exc)[:200]}") from exc
