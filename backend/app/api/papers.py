"""论文管理 API"""
import os
import re
import uuid
import json
import shutil
from pathlib import Path
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func, or_

from app.database import get_db
from app.config import settings
from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.models.paper_chunk import PaperChunk
from app.models.translation_cache import TranslationCache
from app.services.docling import docling_service
from app.services.ingestion import paper_ingestion_service
from app.services.ingestion import vector_index_service
from app.services.llm import LLMMessage, LLMRequest, llm_router

router = APIRouter(prefix="/api/papers", tags=["论文管理"])

# 内存存储（后续可替换为数据库查询）
_papers_store: dict[str, dict] = {}

_PLACEHOLDER_ABSTRACT_PATTERNS = (
    re.compile(r"^文件大小:\s*\d+\s*bytes$", re.IGNORECASE),
    re.compile(r"^PDF 解析失败:", re.IGNORECASE),
)


def _safe_json_loads(value: str, fallback):
    try:
        return json.loads(value or "")
    except Exception:
        return fallback


def _paper_to_dict(p: Paper) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "authors": p.authors,
        "abstract": p.abstract,
        "year": p.year,
        "source": p.source,
        "source_id": p.source_id,
        "source_url": getattr(p, "source_url", ""),
        "document_type": getattr(p, "document_type", "pdf"),
        "file_path": p.file_path,
        "markdown_path": getattr(p, "markdown_path", ""),
        "tags": p.tags,
        "page_count": p.page_count,
        "pdf_metadata": _safe_json_loads(p.pdf_metadata_json, {}),
        "ai_summary_md": p.ai_summary_md,
        "reader_profile": _safe_json_loads(p.reader_profile_json, {}),
        "added_at": p.added_at.isoformat() if p.added_at else "",
        "last_read_at": p.last_read_at.isoformat() if p.last_read_at else None,
        "read_progress": p.read_progress,
        "is_indexed": p.is_indexed,
    }


def _merge_reader_profile(paper: Paper, updates: dict) -> dict:
    current = _safe_json_loads(paper.reader_profile_json, {})
    merged = {**current, **updates}
    paper.reader_profile_json = json.dumps(merged, ensure_ascii=False)
    return merged


def _index_profile_updates(
    *,
    status: str,
    error: str = "",
    blocks: int = 0,
    chunks: int = 0,
    indexed_at: str | None = None,
) -> dict:
    return {
        "indexing_status": status,
        "indexing_error": error,
        "indexed_block_count": blocks,
        "indexed_chunk_count": chunks,
        "last_indexed_at": indexed_at,
    }


def _sync_memory_store(paper_data: dict):
    _papers_store[paper_data["id"]] = paper_data


def _normalize_inline_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\x00", " ")).strip(" \t\r\n-_")


def _default_title_from_path(file_path: str) -> str:
    return os.path.splitext(os.path.basename(file_path or ""))[0]


def _sanitize_filename(filename: str | None, fallback_stem: str = "paper") -> str:
    candidate = _normalize_inline_text(filename) or fallback_stem
    candidate = candidate.replace("/", "_").replace("\\", "_")
    candidate = re.sub(r"[^\w.\- ()\u4e00-\u9fff]+", "_", candidate).strip(" ._")
    if not candidate:
        candidate = fallback_stem
    return candidate


def _is_placeholder_abstract(value: str | None) -> bool:
    text = _normalize_inline_text(value)
    if not text:
        return True
    return any(pattern.match(text) for pattern in _PLACEHOLDER_ABSTRACT_PATTERNS)


def _is_placeholder_title(title: str | None, file_path: str) -> bool:
    normalized = _normalize_inline_text(title)
    fallback = _normalize_inline_text(_default_title_from_path(file_path))
    if not normalized:
        return True
    if normalized.lower().endswith(".pdf"):
        return True
    return bool(fallback and normalized.lower() == fallback.lower())


def _looks_like_heading(text: str) -> bool:
    candidate = _normalize_inline_text(text)
    if not candidate:
        return False
    if re.match(r"^(keywords?|index terms?)\b", candidate, re.IGNORECASE):
        return True
    if re.match(r"^(introduction|background|methods?|related work|conclusion|references)\b", candidate, re.IGNORECASE):
        return True
    if re.match(r"^([1I]|[A-Z])[\.\)]\s+[A-Z]", candidate):
        return True
    return candidate.isupper() and 1 <= len(candidate.split()) <= 8


def _extract_first_page_lines(page) -> list[dict]:
    page_dict = page.get_text("dict")
    lines: list[dict] = []
    for block in page_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = _normalize_inline_text("".join(span.get("text", "") for span in spans))
            if not text:
                continue
            font_sizes = [float(span.get("size", 0) or 0) for span in spans]
            bbox = line.get("bbox", [0, 0, 0, 0])
            lines.append(
                {
                    "text": text,
                    "size": (sum(font_sizes) / len(font_sizes)) if font_sizes else 0.0,
                    "y0": float(bbox[1]),
                    "y1": float(bbox[3]),
                }
            )
    lines.sort(key=lambda item: (item["y0"], -item["size"]))
    return lines


def _extract_title_from_lines(lines: list[dict], page_height: float, fallback_title: str) -> str:
    if not lines:
        return fallback_title

    max_size = max((line["size"] for line in lines), default=0.0)
    threshold = max(max_size * 0.9, 12.0)
    candidates = [
        line for line in lines
        if line["size"] >= threshold
        and line["y0"] <= page_height * 0.38
        and len(line["text"]) >= 6
        and not _looks_like_heading(line["text"])
    ]
    if not candidates:
        candidates = [
            line for line in lines
            if line["size"] >= max(max_size * 0.82, 11.0)
            and line["y0"] <= page_height * 0.32
            and len(line["text"]) >= 6
            and not _looks_like_heading(line["text"])
        ]
    if not candidates:
        return fallback_title

    merged: list[str] = [candidates[0]["text"]]
    prev = candidates[0]
    for line in candidates[1:]:
        close_enough = (line["y0"] - prev["y1"]) <= max(prev["size"], line["size"]) * 1.6
        similar_size = abs(line["size"] - prev["size"]) <= 1.5
        if close_enough and similar_size:
            merged.append(line["text"])
            prev = line
            continue
        break

    title = _normalize_inline_text(" ".join(merged))
    if len(title) > 300 or len(title) < 6:
        return fallback_title
    return title


def _extract_abstract_from_lines(lines: list[dict]) -> str:
    if not lines:
        return ""

    start_index: int | None = None
    collected: list[str] = []
    max_chars = 2200

    for index, line in enumerate(lines):
        text = line["text"]
        match = re.match(r"^abstract[\s:.\-–—]*(.*)$", text, re.IGNORECASE)
        if not match:
            continue
        start_index = index + 1
        inline_tail = _normalize_inline_text(match.group(1))
        if inline_tail:
            collected.append(inline_tail)
        break

    if start_index is None:
        return ""

    for line in lines[start_index:]:
        text = line["text"]
        if _looks_like_heading(text):
            break
        if len(" ".join(collected)) >= max_chars:
            break
        collected.append(text)

    abstract = _normalize_inline_text(" ".join(collected))
    if len(abstract) < 40:
        return ""
    return abstract[:max_chars]


def _extract_document_metadata(
    source_ref: str,
    fallback_title: str,
    *,
    paper_id: str = "",
    artifact_dir: Path | None = None,
    asset_url_prefix: str = "",
) -> dict:
    extracted = {
        "title": fallback_title,
        "abstract": "",
        "page_count": 0,
        "document_type": "document",
        "pdf_metadata": {},
        "markdown": "",
    }
    try:
        extraction = docling_service.extract(
            source_ref,
            paper_id=paper_id,
            artifact_dir=artifact_dir,
            asset_url_prefix=asset_url_prefix,
        )
        extracted["title"] = _normalize_inline_text(extraction.title) or fallback_title
        extracted["abstract"] = _normalize_inline_text(extraction.abstract)
        extracted["page_count"] = extraction.page_count
        extracted["document_type"] = extraction.source_type
        extracted["markdown"] = extraction.markdown
        extracted["pdf_metadata"] = {
            **(extraction.metadata or {}),
            "detected_title": extracted["title"],
            "source_ref": source_ref,
            "document_type": extraction.source_type,
            "page_sources": [
                {
                    "page_number": page.page_number,
                    "text": page.text,
                    "markdown": page.markdown,
                }
                for page in extraction.page_sources
            ],
        }
        return extracted
    except Exception:
        return extracted


def _paper_source_ref(paper: Paper) -> str:
    return (paper.file_path or "").strip() or (getattr(paper, "source_url", "") or "").strip()


async def _refresh_paper_metadata_if_needed(db: AsyncSession, paper: Paper) -> bool:
    source_ref = _paper_source_ref(paper)
    if not source_ref:
        return False

    needs_refresh = (
        _is_placeholder_title(paper.title, source_ref)
        or _is_placeholder_abstract(paper.abstract)
        or paper.page_count <= 0
        or not _safe_json_loads(paper.pdf_metadata_json, {})
    )
    if not needs_refresh:
        return False

    try:
        extracted = _extract_document_metadata(source_ref, _default_title_from_path(source_ref))
    except Exception:
        return False

    changed = False
    detected_title = extracted["title"]
    detected_abstract = extracted["abstract"]
    detected_metadata = extracted["pdf_metadata"]
    detected_page_count = extracted["page_count"]

    if detected_title and (_is_placeholder_title(paper.title, source_ref) or not _normalize_inline_text(paper.title)) and detected_title != paper.title:
        paper.title = detected_title
        changed = True

    if detected_abstract and detected_abstract != (paper.abstract or ""):
        paper.abstract = detected_abstract
        changed = True

    if detected_page_count and detected_page_count != (paper.page_count or 0):
        paper.page_count = detected_page_count
        changed = True

    current_metadata = _safe_json_loads(paper.pdf_metadata_json, {})
    if detected_metadata and detected_metadata != current_metadata:
        paper.pdf_metadata_json = json.dumps(detected_metadata, ensure_ascii=False)
        changed = True
    if extracted.get("document_type") and extracted["document_type"] != getattr(paper, "document_type", ""):
        paper.document_type = extracted["document_type"]
        changed = True

    return changed


async def create_paper_from_source(
    db: AsyncSession,
    *,
    filename: str = "",
    content: bytes | None = None,
    source_ref: str = "",
    source: str = "local",
    source_id: str = "",
    source_url: str = "",
    authors: Optional[list[str]] = None,
    abstract: str = "",
    title: str = "",
    year: Optional[int] = None,
    extra_pdf_metadata: Optional[dict[str, str]] = None,
) -> dict:
    paper_id = str(uuid.uuid4())
    paper_dir = settings.PAPERS_DIR / paper_id
    paper_dir.mkdir(parents=True, exist_ok=True)

    saved_file_path = ""
    resolved_source_url = _normalize_inline_text(source_url)
    resolved_source_ref = _normalize_inline_text(source_ref)

    fallback_name = filename or resolved_source_ref or resolved_source_url or "paper"
    fallback_title = _normalize_inline_text(title) or os.path.splitext(os.path.basename(fallback_name))[0] or "paper"
    if content is not None:
        safe_filename = _sanitize_filename(filename, fallback_title or "paper")
        file_path = paper_dir / safe_filename
        file_path.write_bytes(content)
        saved_file_path = str(file_path)
        resolved_source_ref = saved_file_path
    elif resolved_source_ref and "://" not in resolved_source_ref:
        saved_file_path = resolved_source_ref

    detected_title = fallback_title
    detected_abstract = ""
    page_count = 0
    document_type = "document"
    pdf_metadata: dict[str, str] = {}
    extracted_markdown = ""

    try:
        extracted = _extract_document_metadata(
            resolved_source_ref or resolved_source_url,
            fallback_title,
            paper_id=paper_id,
            artifact_dir=paper_dir / "artifacts",
            asset_url_prefix=f"/api/papers/{paper_id}/artifacts",
        )
        detected_title = extracted["title"] or fallback_title
        detected_abstract = extracted["abstract"]
        page_count = extracted["page_count"]
        document_type = extracted.get("document_type", "document")
        pdf_metadata = extracted["pdf_metadata"]
        extracted_markdown = extracted.get("markdown", "")
    except Exception as exc:
        detected_abstract = f"文档解析失败: {str(exc)[:200]}"

    markdown_path = paper_dir / "source.md"
    markdown_path.write_text(extracted_markdown or "", encoding="utf-8")
    page_sources_dir = paper_dir / "page_sources"
    page_sources_dir.mkdir(parents=True, exist_ok=True)
    page_sources = (pdf_metadata.get("page_sources") or []) if isinstance(pdf_metadata.get("page_sources"), list) else []
    for page_source in page_sources:
        try:
            page_number = int(page_source.get("page_number", 0) or 0)
        except Exception:
            page_number = 0
        if page_number <= 0:
            continue
        (page_sources_dir / f"page-{page_number:04d}.md").write_text(page_source.get("markdown", "") or "", encoding="utf-8")
        (page_sources_dir / f"page-{page_number:04d}.txt").write_text(page_source.get("text", "") or "", encoding="utf-8")

    final_title = _normalize_inline_text(title) or detected_title or fallback_title
    final_abstract = _normalize_inline_text(abstract) or detected_abstract
    merged_pdf_metadata = {
        **pdf_metadata,
        **(extra_pdf_metadata or {}),
    }
    if final_title:
        merged_pdf_metadata.setdefault("detected_title", final_title)
    if resolved_source_url:
        merged_pdf_metadata.setdefault("source_url", resolved_source_url)

    reader_profile = {
        "auto_full_translation_enabled": False,
        "auto_full_translation_mode": "quick",
        "auto_full_translation_status": "idle",
        "translated_pages": 0,
        "failed_pages": [],
        "last_summary_refresh_at": None,
        **_index_profile_updates(status="pending"),
    }

    paper_data = {
        "id": paper_id,
        "title": final_title,
        "authors": json.dumps(authors or [], ensure_ascii=False),
        "abstract": final_abstract,
        "year": year if year is not None else (datetime.utcnow().year if source == "local" else None),
        "source": source,
        "source_id": source_id,
        "source_url": resolved_source_url,
        "document_type": document_type,
        "file_path": saved_file_path,
        "markdown_path": str(markdown_path),
        "tags": "[]",
        "page_count": page_count,
        "pdf_metadata": merged_pdf_metadata,
        "ai_summary_md": "",
        "reader_profile": reader_profile,
        "added_at": datetime.utcnow().isoformat(),
        "last_read_at": None,
        "read_progress": 0.0,
        "is_indexed": False,
    }

    try:
        paper = Paper(
            id=paper_id,
            title=paper_data["title"],
            authors=paper_data["authors"],
            abstract=paper_data["abstract"],
            year=paper_data["year"],
            source=source,
            source_id=source_id,
            source_url=resolved_source_url,
            document_type=document_type,
            file_path=saved_file_path,
            markdown_path=str(markdown_path),
            tags="[]",
            page_count=page_count,
            pdf_metadata_json=json.dumps(merged_pdf_metadata, ensure_ascii=False),
            ai_summary_md="",
            reader_profile_json=json.dumps(reader_profile, ensure_ascii=False),
            added_at=datetime.utcnow(),
            read_progress=0.0,
            is_indexed=False,
        )
        db.add(paper)
        await db.commit()
        await db.refresh(paper)
        ingestion_result = await paper_ingestion_service.ingest(paper, db)
        paper_data["is_indexed"] = ingestion_result["is_indexed"]
        paper_data["file_path"] = paper.file_path
        paper_data["reader_profile"] = {
            **paper_data["reader_profile"],
            **_index_profile_updates(
                status="ready" if ingestion_result["is_indexed"] else "empty",
                error="",
                blocks=ingestion_result["blocks"],
                chunks=ingestion_result["chunks"],
                indexed_at=datetime.utcnow().isoformat(),
            ),
        }
        paper.reader_profile_json = json.dumps(paper_data["reader_profile"], ensure_ascii=False)
        await db.commit()
    except Exception as exc:
        paper_data["reader_profile"] = {
            **paper_data["reader_profile"],
            **_index_profile_updates(
                status="failed",
                error=str(exc)[:500],
            ),
        }
        try:
            result = await db.execute(select(Paper).where(Paper.id == paper_id))
            existing_paper = result.scalar_one_or_none()
            if existing_paper:
                existing_paper.reader_profile_json = json.dumps(paper_data["reader_profile"], ensure_ascii=False)
                await db.commit()
        except Exception:
            pass

    _sync_memory_store(paper_data)
    return paper_data


async def create_paper_from_pdf_bytes(
    db: AsyncSession,
    *,
    filename: str,
    content: bytes,
    source: str = "local",
    source_id: str = "",
    authors: Optional[list[str]] = None,
    abstract: str = "",
    title: str = "",
    year: Optional[int] = None,
    extra_pdf_metadata: Optional[dict[str, str]] = None,
) -> dict:
    return await create_paper_from_source(
        db,
        filename=filename,
        content=content,
        source=source,
        source_id=source_id,
        authors=authors,
        abstract=abstract,
        title=title,
        year=year,
        extra_pdf_metadata=extra_pdf_metadata,
    )


async def _reindex_paper(db: AsyncSession, paper: Paper) -> dict:
    profile = _merge_reader_profile(paper, _index_profile_updates(status="running", error=""))
    paper.is_indexed = False
    await db.commit()

    try:
        ingestion_result = await paper_ingestion_service.ingest(paper, db)
        profile = _merge_reader_profile(
            paper,
            _index_profile_updates(
                status="ready" if ingestion_result["is_indexed"] else "empty",
                error="",
                blocks=ingestion_result["blocks"],
                chunks=ingestion_result["chunks"],
                indexed_at=datetime.utcnow().isoformat(),
            ),
        )
        paper.is_indexed = ingestion_result["is_indexed"]
        await db.commit()
        await db.refresh(paper)
        paper_data = _paper_to_dict(paper)
        paper_data["reader_profile"] = profile
        _sync_memory_store(paper_data)
        return {
            "paper": paper_data,
            "ingestion": ingestion_result,
        }
    except Exception as exc:
        profile = _merge_reader_profile(
            paper,
            _index_profile_updates(
                status="failed",
                error=str(exc)[:500],
            ),
        )
        paper.is_indexed = False
        await db.commit()
        await db.refresh(paper)
        paper_data = _paper_to_dict(paper)
        paper_data["reader_profile"] = profile
        _sync_memory_store(paper_data)
        raise HTTPException(status_code=500, detail=f"重建索引失败: {str(exc)[:300]}")


async def _load_paper_or_404(db: AsyncSession, paper_id: str) -> Paper:
    result = await db.execute(select(Paper).where(Paper.id == paper_id))
    paper = result.scalar_one_or_none()
    if not paper:
        raise HTTPException(status_code=404, detail="论文不存在")
    return paper


async def _load_translated_pages(db: AsyncSession, paper_id: str, mode: str) -> list[dict]:
    rows = (
        await db.execute(
            select(TranslationCache)
            .where(TranslationCache.paper_id == paper_id, TranslationCache.mode == mode)
            .order_by(TranslationCache.created_at.desc())
        )
    ).scalars().all()

    latest_by_page: dict[int, TranslationCache] = {}
    for row in rows:
        match = re.match(r"page-(\d+)-", row.block_id or "")
        if not match:
            continue
        page_number = int(match.group(1))
        if page_number not in latest_by_page:
            latest_by_page[page_number] = row

    return [
        {
            "page_number": page_number,
            "translated_text": row.translated_text,
            "model_used": row.model_used,
        }
        for page_number, row in sorted(latest_by_page.items(), key=lambda item: item[0])
    ]


def _apply_memory_paper_filters(
    papers: list[dict],
    *,
    query: str = "",
    tag: Optional[str] = None,
    source: Optional[str] = None,
    indexed: Optional[bool] = None,
    year: Optional[int] = None,
    sort: str = "recent",
) -> list[dict]:
    normalized_query = (query or "").strip().lower()
    filtered = papers

    if normalized_query:
        filtered = [
            paper
            for paper in filtered
            if normalized_query in (paper.get("title") or "").lower()
            or normalized_query in (paper.get("abstract") or "").lower()
            or normalized_query in (paper.get("authors") or "").lower()
        ]

    if tag:
        filtered = [paper for paper in filtered if tag in (paper.get("tags") or "")]

    if source and source != "all":
        filtered = [paper for paper in filtered if (paper.get("source") or "") == source]

    if indexed is not None:
        filtered = [paper for paper in filtered if bool(paper.get("is_indexed")) is indexed]

    if year is not None:
        filtered = [paper for paper in filtered if paper.get("year") == year]

    if sort == "title":
        filtered.sort(key=lambda paper: (paper.get("title") or "").lower())
    elif sort == "year":
        filtered.sort(key=lambda paper: (paper.get("year") or 0, paper.get("added_at") or ""), reverse=True)
    elif sort == "progress":
        filtered.sort(key=lambda paper: (paper.get("read_progress") or 0, paper.get("added_at") or ""), reverse=True)
    else:
        filtered.sort(key=lambda paper: paper.get("added_at") or "", reverse=True)

    return filtered


async def _generate_ai_summary_md(paper: Paper, translated_pages: list[dict], mode: str) -> str:
    if not translated_pages:
        return (
            f"# {paper.title or '论文画像'}\n\n"
            "## 当前状态\n\n"
            "- 暂无可用的全文译文，尚不能生成基于译文的论文画像。\n"
            f"- 原始摘要预览：{(paper.abstract or '暂无摘要')[:600]}"
        )

    snippets: list[str] = []
    total_chars = 0
    for item in translated_pages:
        section = f"## 第 {item['page_number']} 页\n\n{item['translated_text'].strip()}"
        if not item["translated_text"].strip():
            continue
        if total_chars + len(section) > 18000:
            break
        snippets.append(section)
        total_chars += len(section)

    translated_context = "\n\n".join(snippets)
    if not translated_context:
        return f"# {paper.title or '论文画像'}\n\n暂无足够译文可用于总结。"

    try:
        response = await llm_router.chat(
            LLMRequest(
                messages=[
                    LLMMessage(
                        role="system",
                        content=(
                            "你是一个论文阅读助手。请基于论文标题、摘要和已翻译的正文片段，"
                            "输出结构化 Markdown 论文画像。必须包含："
                            "论文主题、核心问题、方法概览、关键结论、可继续追问的方向。"
                            "如果信息不足，需要明确写出“信息不足”。"
                        ),
                    ),
                    LLMMessage(
                        role="user",
                        content=(
                            f"标题：{paper.title}\n\n"
                            f"摘要：{paper.abstract or '暂无摘要'}\n\n"
                            f"译文模式：{mode}\n\n"
                            f"已翻译正文片段：\n{translated_context}"
                        ),
                    ),
                ],
                max_tokens=1600,
                temperature=0.2,
            )
        )
        return response.content.strip() or f"# {paper.title or '论文画像'}\n\n暂无可用总结。"
    except Exception as exc:
        return (
            f"# {paper.title or '论文画像'}\n\n"
            "## 当前状态\n\n"
            f"- AI 总结生成失败：{str(exc)[:200]}\n"
            f"- 已完成译文页数：{len(translated_pages)}\n"
            f"- 原始摘要预览：{(paper.abstract or '暂无摘要')[:600]}"
        )


@router.get("")
async def list_papers(
    page: int = 1,
    page_size: int = 24,
    query: str = "",
    tag: Optional[str] = None,
    source: Optional[str] = None,
    indexed: Optional[bool] = None,
    year: Optional[int] = None,
    sort: str = "recent",
    db: AsyncSession = Depends(get_db),
):
    """获取论文列表"""
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    sort = sort if sort in {"recent", "title", "year", "progress"} else "recent"
    try:
        stmt = select(Paper)
        count_stmt = select(func.count(Paper.id))

        normalized_query = (query or "").strip()
        if normalized_query:
            like_query = f"%{normalized_query}%"
            condition = or_(
                Paper.title.ilike(like_query),
                Paper.abstract.ilike(like_query),
                Paper.authors.ilike(like_query),
            )
            stmt = stmt.where(condition)
            count_stmt = count_stmt.where(condition)
        if tag:
            stmt = stmt.where(Paper.tags.contains(tag))
            count_stmt = count_stmt.where(Paper.tags.contains(tag))
        if source and source != "all":
            stmt = stmt.where(Paper.source == source)
            count_stmt = count_stmt.where(Paper.source == source)
        if indexed is not None:
            stmt = stmt.where(Paper.is_indexed == indexed)
            count_stmt = count_stmt.where(Paper.is_indexed == indexed)
        if year is not None:
            stmt = stmt.where(Paper.year == year)
            count_stmt = count_stmt.where(Paper.year == year)

        if sort == "title":
            stmt = stmt.order_by(Paper.title.asc(), Paper.added_at.desc())
        elif sort == "year":
            stmt = stmt.order_by(func.coalesce(Paper.year, 0).desc(), Paper.added_at.desc())
        elif sort == "progress":
            stmt = stmt.order_by(Paper.read_progress.desc(), Paper.added_at.desc())
        else:
            stmt = stmt.order_by(Paper.added_at.desc())

        stmt = stmt.offset((page - 1) * page_size).limit(page_size)

        result = await db.execute(stmt)
        papers = result.scalars().all()
        serialized_papers = [_paper_to_dict(p) for p in papers]
        for paper_data in serialized_papers:
            _sync_memory_store(paper_data)

        total_result = await db.execute(count_stmt)
        total = total_result.scalar() or 0

        return {
            "papers": serialized_papers,
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    except Exception as e:
        # 数据库不可用时回退到内存存储
        papers = _apply_memory_paper_filters(
            list(_papers_store.values()),
            query=query,
            tag=tag,
            source=source,
            indexed=indexed,
            year=year,
            sort=sort,
        )
        return {
            "papers": papers[(page-1)*page_size : page*page_size],
            "total": len(papers),
            "page": page,
            "page_size": page_size,
        }


@router.post("/upload")
async def upload_paper(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """上传文件并通过 Docling 提取内容。"""
    if not file.filename:
        raise HTTPException(status_code=400, detail="缺少文件名")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")
    paper_data = await create_paper_from_source(
        db,
        filename=file.filename,
        content=content,
        source="local",
        source_id="",
    )

    return {
        "message": "上传成功",
        "paper": paper_data,
    }


@router.get("/chunks")
async def list_paper_chunks(
    paper_id: Optional[str] = None,
    page: Optional[int] = None,
    limit: int = 500,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """查看持久化的 paper_chunks，支持按论文和页码过滤。"""
    limit = max(1, min(limit, 2000))
    offset = max(0, offset)

    filters = []
    if paper_id:
        filters.append(PaperChunk.paper_id == paper_id)
    if page is not None:
        filters.append(PaperChunk.page_number == page)

    count_stmt = select(func.count()).select_from(PaperChunk)
    if filters:
        count_stmt = count_stmt.where(*filters)
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(PaperChunk, Paper.title)
        .join(Paper, Paper.id == PaperChunk.paper_id)
        .order_by(PaperChunk.paper_id.asc(), PaperChunk.page_number.asc(), PaperChunk.chunk_id.asc())
        .offset(offset)
        .limit(limit)
    )
    if filters:
        stmt = stmt.where(*filters)

    rows = (await db.execute(stmt)).all()
    chunks = []
    for chunk, paper_title in rows:
        metadata = _safe_json_loads(chunk.metadata_json, {})
        chunks.append(
            {
                "id": chunk.id,
                "paper_id": chunk.paper_id,
                "paper_title": paper_title or "",
                "chunk_id": chunk.chunk_id,
                "page": chunk.page_number,
                "block_id": chunk.block_id,
                "text": chunk.text,
                "metadata": metadata,
                "created_at": chunk.created_at.isoformat() if chunk.created_at else None,
            }
        )

    return {
        "paper_id": paper_id,
        "page": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "chunks": chunks,
    }


@router.get("/{paper_id}")
async def get_paper(paper_id: str, db: AsyncSession = Depends(get_db)):
    """获取论文详情"""
    try:
        result = await db.execute(select(Paper).where(Paper.id == paper_id))
        paper = result.scalar_one_or_none()
        if paper:
            paper_data = _paper_to_dict(paper)
            _sync_memory_store(paper_data)
            return paper_data
    except Exception:
        pass

    if paper_id in _papers_store:
        return _papers_store[paper_id]

    raise HTTPException(status_code=404, detail="论文不存在")


@router.patch("/{paper_id}/reader-profile")
async def update_reader_profile(
    paper_id: str,
    data: dict,
    db: AsyncSession = Depends(get_db),
):
    """持久化阅读态和自动翻译进度。"""
    if paper_id in _papers_store:
        memory_paper = _papers_store[paper_id]
        memory_paper["reader_profile"] = {
            **memory_paper.get("reader_profile", {}),
            **data,
        }
        if "ai_summary_md" in data:
            memory_paper["ai_summary_md"] = data.get("ai_summary_md", "")

    try:
        paper = await _load_paper_or_404(db, paper_id)
        _merge_reader_profile(paper, data)
        if "ai_summary_md" in data:
            paper.ai_summary_md = data.get("ai_summary_md", "")
        await db.commit()
        await db.refresh(paper)
        paper_data = _paper_to_dict(paper)
        _sync_memory_store(paper_data)
        return paper_data
    except HTTPException:
        raise
    except Exception:
        if paper_id in _papers_store:
            return _papers_store[paper_id]
        raise


@router.post("/{paper_id}/reindex")
async def reindex_paper(
    paper_id: str,
    db: AsyncSession = Depends(get_db),
):
    """重建论文 blocks/chunks 索引。"""
    paper = await _load_paper_or_404(db, paper_id)
    source_ref = _paper_source_ref(paper)
    if not source_ref or ("://" not in source_ref and not os.path.exists(source_ref)):
        raise HTTPException(status_code=404, detail="源文档不存在，无法重建索引")
    return await _reindex_paper(db, paper)


@router.post("/{paper_id}/reader-profile/refresh")
async def refresh_reader_profile(
    paper_id: str,
    data: dict,
    db: AsyncSession = Depends(get_db),
):
    """基于已落库的全文翻译刷新论文画像。"""
    mode = data.get("mode", "quick")
    profile_updates = data.get("profile", {})

    paper = await _load_paper_or_404(db, paper_id)
    translated_pages = await _load_translated_pages(db, paper_id, mode)
    summary_md = await _generate_ai_summary_md(paper, translated_pages, mode)

    merged_profile = _merge_reader_profile(
        paper,
        {
            **profile_updates,
            "summary_translation_mode": mode,
            "translated_pages": profile_updates.get("translated_pages", len(translated_pages)),
            "last_summary_refresh_at": datetime.utcnow().isoformat(),
        },
    )
    paper.ai_summary_md = summary_md

    await db.commit()
    await paper_ingestion_service.rebuild_vector_index(paper, db)
    await db.refresh(paper)

    paper_data = _paper_to_dict(paper)
    paper_data["reader_profile"] = merged_profile
    _sync_memory_store(paper_data)
    return paper_data


@router.delete("/{paper_id}")
async def delete_paper(paper_id: str, db: AsyncSession = Depends(get_db)):
    """删除论文"""
    # 删除文件
    paper_dir = settings.PAPERS_DIR / paper_id
    if paper_dir.exists():
        shutil.rmtree(paper_dir)

    # 删除内存记录
    _papers_store.pop(paper_id, None)

    # 删除数据库记录
    try:
        vector_index_service.delete_paper(paper_id)
        await db.execute(delete(PaperBlock).where(PaperBlock.paper_id == paper_id))
        await db.execute(delete(PaperChunk).where(PaperChunk.paper_id == paper_id))
        result = await db.execute(select(Paper).where(Paper.id == paper_id))
        paper = result.scalar_one_or_none()
        if paper:
            await db.delete(paper)
            await db.commit()
    except Exception:
        pass

    return {"message": "删除成功", "paper_id": paper_id}


@router.get("/{paper_id}/artifacts/{artifact_name:path}")
async def get_paper_artifact(paper_id: str, artifact_name: str):
    """返回 Docling 导出的图片等 artifacts。"""
    artifact_root = (settings.PAPERS_DIR / paper_id / "artifacts").resolve()
    target = (artifact_root / artifact_name).resolve()
    if not str(target).startswith(str(artifact_root)) or not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="artifact 不存在")
    return FileResponse(path=str(target), filename=target.name)


@router.get("/{paper_id}/file")
async def get_paper_file(paper_id: str):
    """获取 PDF 文件（供前端渲染）。"""
    from app.database import async_session_factory

    async with async_session_factory() as session:
        paper = (await session.execute(select(Paper).where(Paper.id == paper_id))).scalar_one_or_none()
        if paper and paper.file_path and paper.file_path.lower().endswith(".pdf") and os.path.exists(paper.file_path):
            return FileResponse(
                path=paper.file_path,
                media_type="application/pdf",
                filename=os.path.basename(paper.file_path),
            )

    raise HTTPException(status_code=404, detail="PDF 文件不存在")


@router.get("/{paper_id}/blocks")
async def get_paper_blocks(paper_id: str, page: Optional[int] = None):
    """获取解析后的文本块"""
    from app.database import async_session_factory

    async with async_session_factory() as session:
        stmt = select(PaperBlock).where(PaperBlock.paper_id == paper_id).order_by(PaperBlock.page_number.asc(), PaperBlock.created_at.asc())
        if page is not None:
            stmt = stmt.where(PaperBlock.page_number == page)
        rows = (await session.execute(stmt)).scalars().all()
        blocks = [
            {
                "id": row.block_id,
                "text": row.text,
                "page": row.page_number,
                "bbox": json.loads(row.bbox_json or "[]"),
                "block_type": row.block_type,
                "section_title": row.section_title,
            }
            for row in rows
        ]
    return {
        "paper_id": paper_id,
        "blocks": blocks,
    }


@router.get("/{paper_id}/page-source")
async def get_paper_page_source(
    paper_id: str,
    page: int,
    db: AsyncSession = Depends(get_db),
):
    """返回指定页的 Docling 提取原文和 markdown。"""
    page_number = max(1, page)
    paper = await _load_paper_or_404(db, paper_id)
    page_sources_dir = settings.PAPERS_DIR / paper_id / "page_sources"
    page_markdown_path = page_sources_dir / f"page-{page_number:04d}.md"
    page_text_path = page_sources_dir / f"page-{page_number:04d}.txt"

    if page_markdown_path.exists() or page_text_path.exists():
        text = page_text_path.read_text(encoding="utf-8") if page_text_path.exists() else ""
        markdown = page_markdown_path.read_text(encoding="utf-8") if page_markdown_path.exists() else ""
        stmt = (
            select(func.count())
            .select_from(PaperBlock)
            .where(PaperBlock.paper_id == paper_id, PaperBlock.page_number == page_number)
        )
        block_count = (await db.execute(stmt)).scalar() or 0
        image_count = markdown.count("![")
        return {
            "paper_id": paper_id,
            "page_number": page_number,
            "document_type": getattr(paper, "document_type", "pdf"),
            "block_count": block_count,
            "text": text,
            "markdown": markdown,
            "image_count": image_count,
        }

    stmt = (
        select(PaperBlock)
        .where(PaperBlock.paper_id == paper_id, PaperBlock.page_number == page_number)
        .order_by(PaperBlock.created_at.asc())
    )
    rows = (await db.execute(stmt)).scalars().all()

    def render_markdown(block_type: str, text: str) -> str:
        normalized = (text or "").strip()
        if not normalized:
            return ""
        if block_type == "heading":
            return f"## {normalized}"
        if block_type == "equation":
            return f"$$\n{normalized}\n$$"
        return normalized

    text = "\n\n".join((row.text or "").strip() for row in rows if (row.text or "").strip())
    markdown = "\n\n".join(render_markdown(row.block_type, row.text) for row in rows if (row.text or "").strip())
    return {
        "paper_id": paper_id,
        "page_number": page_number,
        "document_type": getattr(paper, "document_type", "pdf"),
        "block_count": len(rows),
        "text": text,
        "markdown": markdown,
        "image_count": markdown.count("!["),
    }


@router.get("/{paper_id}/markdown")
async def get_paper_markdown(
    paper_id: str,
    db: AsyncSession = Depends(get_db),
):
    """返回 Docling 落地的 markdown 原文。"""
    paper = await _load_paper_or_404(db, paper_id)
    markdown_path = getattr(paper, "markdown_path", "") or ""
    if not markdown_path or not os.path.exists(markdown_path):
        raise HTTPException(status_code=404, detail="提取 markdown 不存在")
    return {
        "paper_id": paper_id,
        "document_type": getattr(paper, "document_type", "pdf"),
        "markdown_path": markdown_path,
        "content": Path(markdown_path).read_text(encoding="utf-8"),
    }
