"""每日论文服务 - 对接 HuggingFace Daily Papers 与 ModelScope 论文推荐"""
import json
import time
from datetime import datetime
from pathlib import Path

import httpx

from app.config import settings

HF_API = "https://huggingface.co/api/daily_papers"
MS_API = "https://modelscope.cn/api/v1/papers"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# 缓存有效期（秒）；同一天内的推荐列表变化不频繁
CACHE_TTL = 1800


def _cache_dir() -> Path:
    cache_dir = settings.CACHE_DIR / "daily_papers"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _read_cache(path: Path, refresh: bool) -> list[dict] | None:
    if refresh or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - data.get("fetched_at", 0) > CACHE_TTL:
            return None
        return data.get("papers") or []
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(path: Path, papers: list[dict]) -> None:
    try:
        path.write_text(
            json.dumps({"fetched_at": time.time(), "papers": papers}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass


def normalize_hf(item: dict) -> dict:
    paper = item.get("paper") or {}
    paper_id = str(paper.get("id") or "")
    authors = [a.get("name", "") for a in (paper.get("authors") or []) if a.get("name")]
    return {
        "source": "huggingface",
        "id": paper_id,
        "title": paper.get("title") or "",
        "authors": authors[:12],
        "abstract": paper.get("summary") or "",
        "url": f"https://huggingface.co/papers/{paper_id}" if paper_id else "",
        "pdf_url": f"https://arxiv.org/pdf/{paper_id}" if paper_id else "",
        "published_at": (paper.get("publishedAt") or "")[:10],
        "upvotes": int(paper.get("upvotes") or 0),
        "comments": int(item.get("numComments") or 0),
        "code_url": paper.get("githubRepo") or "",
        "thumbnail": item.get("thumbnail") or "",
        "keywords": (paper.get("ai_keywords") or [])[:6],
        "rating": 0.0,
    }


def normalize_modelscope(item: dict) -> dict:
    arxiv_id = str(item.get("ArxivId") or "")
    ms_id = str(item.get("Id") or "")
    authors = [a.strip() for a in (item.get("Authors") or "").split(",") if a.strip()]
    return {
        "source": "modelscope",
        "id": arxiv_id or ms_id,
        "title": item.get("Title") or "",
        "authors": authors[:12],
        "abstract": item.get("AbstractCn") or item.get("AbstractEn") or "",
        "url": f"https://modelscope.cn/papers/{ms_id}" if ms_id else "",
        "pdf_url": item.get("PdfUrl") or item.get("ArxivUrl") or "",
        "published_at": (item.get("PublishDate") or "")[:10],
        "upvotes": 0,
        "comments": int(item.get("CommentCount") or 0),
        "code_url": item.get("CodeLink") or "",
        "thumbnail": "",
        "keywords": [],
        "rating": float(item.get("Star") or 0),
    }


async def fetch_hf_papers(date: str = "", refresh: bool = False, limit: int = 30) -> list[dict]:
    """HuggingFace Daily Papers。date=YYYY-MM-DD，空 = 最新一期。"""
    cache_path = _cache_dir() / f"hf-{date or 'latest'}.json"
    cached = _read_cache(cache_path, refresh)
    if cached is not None:
        return cached

    url = HF_API if not date else f"{HF_API}?date={date}"
    try:
        async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            items = resp.json()
    except (httpx.HTTPError, ValueError):
        return cached or []

    papers = [normalize_hf(item) for item in items if isinstance(item, dict)]
    papers = [p for p in papers if p["title"]][:limit]
    _write_cache(cache_path, papers)
    return papers


async def fetch_modelscope_papers(refresh: bool = False, limit: int = 30) -> list[dict]:
    """ModelScope 论文推荐（type=recommend）。"""
    cache_path = _cache_dir() / "ms-recommend.json"
    cached = _read_cache(cache_path, refresh)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as client:
            resp = await client.get(MS_API, params={"page": 1, "size": limit, "type": "recommend"})
            resp.raise_for_status()
            payload = resp.json()
    except (httpx.HTTPError, ValueError):
        return cached or []

    items = ((payload or {}).get("Data") or {}).get("Papers") or []
    papers = [normalize_modelscope(item) for item in items]
    papers = [p for p in papers if p["title"]][:limit]
    _write_cache(cache_path, papers)
    return papers


async def fetch_daily_papers(
    source: str = "all",
    date: str = "",
    refresh: bool = False,
    limit: int = 30,
) -> dict:
    """聚合两个源的每日/推荐论文。"""
    result: dict = {"date": date or datetime.utcnow().strftime("%Y-%m-%d"), "papers": [], "sources": {}}
    if source in ("all", "huggingface", "hf"):
        hf = await fetch_hf_papers(date=date, refresh=refresh, limit=limit)
        result["sources"]["huggingface"] = len(hf)
        result["papers"].extend(hf)
    if source in ("all", "modelscope", "ms"):
        ms = await fetch_modelscope_papers(refresh=refresh, limit=limit)
        result["sources"]["modelscope"] = len(ms)
        result["papers"].extend(ms)
    return result
