"""翻译 API"""
import traceback
import hashlib
import logging
import re
from datetime import datetime
from pathlib import Path
import fitz
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse
from app.config import settings
from app.database import async_session_factory, get_db
from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.models.translation_cache import TranslationCache
from app.services.translation import (
    translation_service,
    TranslationRequest,
    TranslationMode,
    TranslationQualityError,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/translate", tags=["翻译"])
FORMULA_PLACEHOLDER = "<!-- formula-not-decoded -->"
LIGATURE_MAP = {
    "ﬀ": "ff",
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
}


def _serialize_cache_row(row: TranslationCache | None) -> dict | None:
    if not row:
        return None
    return {
        "paper_id": row.paper_id,
        "block_id": row.block_id,
        "original_text": row.original_text,
        "translated_text": row.translated_text,
        "mode": row.mode,
        "model_used": row.model_used,
        "finish_reason": row.finish_reason,
        "prompt_tokens": row.prompt_tokens,
        "completion_tokens": row.completion_tokens,
        "source_text_length": row.source_text_length,
        "translated_text_length": row.translated_text_length,
        "edited_by_user": row.edited_by_user,
        "edited_at": row.edited_at.isoformat() if row.edited_at else None,
        "user_notes": row.user_notes,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _text_digest(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


def _text_preview(text: str, max_chars: int = 160) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())[:max_chars]


def _extract_markdown_images(markdown: str) -> tuple[str, list[dict[str, str]]]:
    images: list[dict[str, str]] = []
    index = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal index
        token = f"[[DOC_IMAGE_{index}]]"
        images.append({"token": token, "markdown": match.group(0)})
        index += 1
        return token

    sanitized = re.sub(r"!\[[^\]]*]\([^)]+\)", replace, markdown or "")
    return sanitized, images


def _extract_markdown_formulas(markdown: str) -> tuple[str, list[dict[str, str]]]:
    formulas: list[dict[str, str]] = []
    index = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal index
        token = f"[[DOC_FORMULA_{index}]]"
        formulas.append({"token": token, "markdown": match.group(0).strip()})
        index += 1
        return token

    sanitized = re.sub(r"\$\$[\s\S]*?\$\$", replace, markdown or "")
    return sanitized, formulas


def _restore_markdown_tokens(markdown: str, entries: list[dict[str, str]]) -> str:
    restored = markdown or ""
    missing: list[str] = []
    for entry in entries:
        token = entry["token"]
        original = entry["markdown"]
        if token in restored:
            restored = restored.replace(token, original)
        else:
            missing.append(original)
    if missing:
        restored = f"{restored.strip()}\n\n" + "\n\n".join(missing)
    return restored.strip()


def _restore_markdown_images(markdown: str, images: list[dict[str, str]]) -> str:
    return _restore_markdown_tokens(markdown, images)


def _paper_translation_root(paper_id: str, mode: str) -> Path:
    return settings.PAPERS_DIR / paper_id / "translations" / mode


def _paper_translation_page_path(paper_id: str, mode: str, page_number: int) -> Path:
    return _paper_translation_root(paper_id, mode) / "pages" / f"page-{page_number:04d}.md"


def _paper_translation_summary_path(paper_id: str, mode: str, page_number: int) -> Path:
    return _paper_translation_root(paper_id, mode) / "summaries" / f"page-{page_number:04d}.md"


def _normalize_auxiliary_text(text: str) -> str:
    cleaned = text or ""
    for source, replacement in LIGATURE_MAP.items():
        cleaned = cleaned.replace(source, replacement)
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in cleaned.replace("\u00a0", " ").replace("\u200b", "").replace("\u00ad", "").splitlines()
    ]
    return "\n\n".join(line for line in lines if line).strip()


def _is_page_text_noise_line(line: str) -> bool:
    normalized = line.strip()
    if not normalized:
        return True
    if re.fullmatch(r"\d+", normalized):
        return True
    if re.fullmatch(r"page\s+\d+(\s+of\s+\d+)?", normalized, re.IGNORECASE):
        return True
    if re.fullmatch(r"\d+\s+[A-Z][A-Za-z .,&-]{2,}", normalized):
        return True
    if (
        re.fullmatch(r"[A-Z][A-Za-z0-9 .:&,-]{2,}\s+\d+", normalized)
        and len(normalized.split()) <= 6
        and not re.match(r"^(Table|Fig|Figure)\b", normalized, re.IGNORECASE)
    ):
        return True
    return False


def _normalize_pdf_page_text(text: str) -> str:
    cleaned = text or ""
    for source, replacement in LIGATURE_MAP.items():
        cleaned = cleaned.replace(source, replacement)
    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in cleaned.replace("\u00a0", " ").replace("\u200b", "").replace("\u00ad", "").splitlines()
    ]
    return "\n\n".join(line for line in lines if not _is_page_text_noise_line(line)).strip()


def _pick_current_page_text(
    *,
    pdfjs_text: str = "",
    pymupdf_text: str = "",
    docling_text: str = "",
    docling_markdown: str = "",
) -> tuple[str, str]:
    candidates = [
        ("PDF.js", _normalize_pdf_page_text(pdfjs_text)),
        ("PyMuPDF", _normalize_pdf_page_text(pymupdf_text)),
        ("Docling text", _normalize_auxiliary_text(docling_text)),
        ("Docling markdown", (docling_markdown or "").strip()),
    ]
    for source_name, text in candidates:
        if text:
            return text, source_name
    return "", ""


def _tail_context(text: str, max_chars: int = 1800) -> str:
    normalized = _normalize_auxiliary_text(text)
    if len(normalized) <= max_chars:
        return normalized
    tail = normalized[-max_chars:].lstrip()
    sentence_start = re.search(r"(?<=[。！？.!?])\s+", tail)
    if sentence_start:
        return tail[sentence_start.end():].strip()
    return tail


def _normalize_formula_signature(text: str) -> str:
    compact = _normalize_auxiliary_text(text).replace("\n", " ")
    return re.sub(r"[^0-9A-Za-z=+\-*/^_(){}\[\].,<>≤≥≈∑∏√λμστωαβγδΔ×∗′' ]+", "", compact).replace(" ", "")


def _looks_like_formula_candidate(text: str) -> bool:
    normalized = _normalize_auxiliary_text(text)
    if not normalized:
        return False
    if len(normalized) < 6 or len(normalized) > 240:
        return False
    signals = len(re.findall(r"[=+\-*/^_≤≥≈∑∏√λμστωαβγδΔ(){}\[\]×∗′']", normalized))
    alpha_words = len(re.findall(r"[A-Za-z]{3,}", normalized))
    digit_count = len(re.findall(r"\d", normalized))
    if signals >= 3:
        return True
    return "=" in normalized and (digit_count > 0 or alpha_words <= 4)


def _collect_formula_candidates(*texts: str) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    for text in texts:
        for raw_line in (text or "").splitlines():
            line = _normalize_auxiliary_text(raw_line)
            if not line or line.startswith("## "):
                continue
            if not _looks_like_formula_candidate(line):
                continue
            signature = _normalize_formula_signature(line)
            if not signature or signature in seen:
                continue
            seen.add(signature)
            candidates.append(line)

    return candidates


def _repair_formula_placeholders(markdown: str, *texts: str) -> str:
    source_markdown = markdown or ""
    if FORMULA_PLACEHOLDER not in source_markdown:
        return source_markdown

    existing_formulas = [
        _normalize_formula_signature(match.group(1))
        for match in re.finditer(r"\$\$\s*([\s\S]*?)\s*\$\$", source_markdown)
    ]
    existing_signatures = {item for item in existing_formulas if item}
    candidates = [
        candidate
        for candidate in _collect_formula_candidates(*texts)
        if _normalize_formula_signature(candidate) not in existing_signatures
    ]
    candidate_iter = iter(candidates)

    def replace(_match: re.Match[str]) -> str:
        candidate = next(candidate_iter, "")
        if not candidate:
            return FORMULA_PLACEHOLDER
        return f"$$\n{candidate}\n$$"

    return re.sub(re.escape(FORMULA_PLACEHOLDER), replace, source_markdown)


def _summarize_markdown_for_context(markdown: str, max_chars: int = 900) -> str:
    blocks: list[str] = []
    total = 0

    for raw_block in re.split(r"\n\s*\n", markdown or ""):
        block = re.sub(r"\s+", " ", raw_block).strip()
        if not block or block.startswith("!["):
            continue
        if block.startswith("$$") and len(block) > 180:
            continue
        if block.startswith("#"):
            candidate = block
        else:
            sentence = re.split(r"(?<=[。！？.!?])\s+", block, maxsplit=1)[0].strip()
            candidate = sentence or block
        if not candidate:
            continue
        remaining = max_chars - total
        if remaining <= 0:
            break
        if len(candidate) > remaining:
            candidate = candidate[:remaining].rstrip()
        blocks.append(candidate)
        total += len(candidate) + 2
        if total >= max_chars:
            break

    return "\n\n".join(blocks).strip()


def _build_previous_summary(paper_id: str, mode: str, page_number: int, lookback_pages: int = 3) -> str:
    start_page = max(1, page_number - lookback_pages)
    sections: list[str] = []
    total_chars = 0

    for current in range(start_page, page_number):
        summary_path = _paper_translation_summary_path(paper_id, mode, current)
        page_path = _paper_translation_page_path(paper_id, mode, current)
        if summary_path.exists():
            summary = summary_path.read_text(encoding="utf-8").strip()
        elif page_path.exists():
            summary = _summarize_markdown_for_context(page_path.read_text(encoding="utf-8"))
        else:
            continue

        if not summary:
            continue
        section = f"## 第 {current} 页\n\n{summary}"
        if total_chars + len(section) > 2200:
            break
        sections.append(section)
        total_chars += len(section)

    return "\n\n".join(sections).strip()


def _load_page_markdown_from_disk(paper_id: str, page_number: int) -> str:
    page_sources_dir = settings.PAPERS_DIR / paper_id / "page_sources"
    path = page_sources_dir / f"page-{page_number:04d}.md"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _load_page_text_from_disk(paper_id: str, page_number: int) -> str:
    page_sources_dir = settings.PAPERS_DIR / paper_id / "page_sources"
    path = page_sources_dir / f"page-{page_number:04d}.txt"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _build_reference_pages_context(paper: Paper, paper_id: str, page_number: int) -> str:
    previous_page = page_number - 1
    if previous_page <= 0:
        return ""

    previous_text = (
        _extract_pdf_page_text_with_pymupdf(getattr(paper, "file_path", "") or "", previous_page)
        or _load_page_text_from_disk(paper_id, previous_page)
        or _load_page_markdown_from_disk(paper_id, previous_page)
    )
    context = _tail_context(previous_text)
    if context:
        return f"<!-- page:{previous_page} context-only -->\n\n{context}"
    return ""


def _extract_pdf_page_text_with_pymupdf(file_path: str, page_number: int) -> str:
    normalized_path = (file_path or "").strip()
    if not normalized_path or not normalized_path.lower().endswith(".pdf"):
        return ""
    try:
        with fitz.open(normalized_path) as doc:
            if page_number < 1 or page_number > len(doc):
                return ""
            page = doc.load_page(page_number - 1)
            return _normalize_pdf_page_text(page.get_text("text", sort=True))
    except Exception:
        return ""


def _build_auxiliary_text(
    paper: Paper,
    *,
    page_number: int,
    pdfjs_text: str = "",
) -> str:
    sections: list[str] = []
    normalized_pdfjs = _normalize_auxiliary_text(pdfjs_text)
    if normalized_pdfjs:
        sections.append(f"## PDF.js Page Text\n\n{normalized_pdfjs}")

    pymupdf_text = _extract_pdf_page_text_with_pymupdf(getattr(paper, "file_path", "") or "", page_number)
    if pymupdf_text and pymupdf_text != normalized_pdfjs:
        sections.append(f"## PyMuPDF Page Text\n\n{pymupdf_text}")

    return "\n\n".join(section for section in sections if section).strip()


def _extract_layout_reference_markdown(markdown: str, max_chars: int = 5000) -> str:
    blocks: list[str] = []
    total = 0

    for raw_block in re.split(r"\n\s*\n", markdown or ""):
        block = raw_block.strip()
        if not block:
            continue
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue

        has_table = any(line.startswith("|") and line.endswith("|") for line in lines)
        has_image = any(line.startswith("![") or "[[DOC_IMAGE_" in line for line in lines)
        has_formula = any("[[DOC_FORMULA_" in line or line.startswith("$$") for line in lines)
        is_heading = all(line.startswith("#") for line in lines[:1])
        is_caption = bool(re.match(r"^(Table|Fig\.|Figure)\s+\d+", lines[0], re.IGNORECASE))
        if not (has_table or has_image or has_formula or is_heading or is_caption):
            continue

        if total + len(block) > max_chars:
            remaining = max_chars - total
            if remaining <= 0:
                break
            block = block[:remaining].rstrip()
        blocks.append(block)
        total += len(block) + 2
        if total >= max_chars:
            break

    return "\n\n".join(blocks).strip()


def _build_page_translation_auxiliary(
    *,
    layout_markdown: str,
    current_text_source: str,
) -> str:
    sections: list[str] = []

    layout_reference = _extract_layout_reference_markdown(layout_markdown)
    if layout_reference:
        sections.append(
            "## Docling Layout Markdown\n\n"
            f"当前页主文本来源：{current_text_source}。这里只提供标题、表格、图片、公式和图表标题等结构参考；正文完整性以原文区为准。\n\n"
            f"{layout_reference}"
        )

    return "\n\n".join(section for section in sections if section).strip()


def _persist_translated_markdown(
    paper_id: str,
    mode: str,
    page_number: int,
    translated_markdown: str,
) -> str:
    root = _paper_translation_root(paper_id, mode)
    pages_dir = root / "pages"
    summaries_dir = root / "summaries"
    pages_dir.mkdir(parents=True, exist_ok=True)
    summaries_dir.mkdir(parents=True, exist_ok=True)

    page_path = _paper_translation_page_path(paper_id, mode, page_number)
    page_path.write_text(translated_markdown or "", encoding="utf-8")

    summary_path = _paper_translation_summary_path(paper_id, mode, page_number)
    summary_path.write_text(_summarize_markdown_for_context(translated_markdown), encoding="utf-8")

    page_files = sorted(pages_dir.glob("page-*.md"))
    document_parts: list[str] = []
    for page_file in page_files:
        match = re.search(r"page-(\d+)\.md$", page_file.name)
        if not match:
            continue
        page_index = int(match.group(1))
        content = page_file.read_text(encoding="utf-8").strip()
        if not content:
            continue
        document_parts.append(f"<!-- page:{page_index} -->\n\n{content}")
    (root / "document.md").write_text("\n\n".join(document_parts).strip(), encoding="utf-8")

    return str(page_path)


async def _load_paper_or_404(db: AsyncSession, paper_id: str) -> Paper:
    paper = (await db.execute(select(Paper).where(Paper.id == paper_id))).scalar_one_or_none()
    if not paper:
        raise HTTPException(status_code=404, detail="论文不存在")
    return paper


async def _load_page_source(db: AsyncSession, paper_id: str, page_number: int) -> dict:
    page_sources_dir = settings.PAPERS_DIR / paper_id / "page_sources"
    page_markdown_path = page_sources_dir / f"page-{page_number:04d}.md"
    page_text_path = page_sources_dir / f"page-{page_number:04d}.txt"

    if page_markdown_path.exists() or page_text_path.exists():
        return {
            "text": page_text_path.read_text(encoding="utf-8") if page_text_path.exists() else "",
            "markdown": page_markdown_path.read_text(encoding="utf-8") if page_markdown_path.exists() else "",
        }

    blocks = await _load_page_blocks(paper_id, page_number)

    def render_markdown(block_type: str, text: str) -> str:
        normalized = (text or "").strip()
        if not normalized:
            return ""
        if block_type == "heading":
            return f"## {normalized}"
        if block_type == "equation":
            return f"$$\n{normalized}\n$$"
        return normalized

    return {
        "text": "\n\n".join(block["text"].strip() for block in blocks if block["text"].strip()),
        "markdown": "\n\n".join(
            render_markdown(block["block_type"], block["text"]) for block in blocks if block["text"].strip()
        ),
    }


async def _upsert_translation_cache(
    db: AsyncSession,
    *,
    paper_id: str,
    block_id: str,
    original_text: str,
    translated_text: str,
    mode: str,
    model_used: str = "",
    finish_reason: str = "",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    source_text_length: int = 0,
    translated_text_length: int = 0,
    edited_by_user: bool = False,
    edited_at: datetime | None = None,
    user_notes: str | None = None,
) -> None:
    existing = (
        await db.execute(
            select(TranslationCache).where(
                TranslationCache.paper_id == paper_id,
                TranslationCache.block_id == block_id,
                TranslationCache.mode == mode,
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.original_text = original_text
        existing.translated_text = translated_text
        existing.agent_mode = f"translate:{mode}"
        existing.model_used = model_used or existing.model_used
        existing.finish_reason = finish_reason or existing.finish_reason
        existing.prompt_tokens = prompt_tokens
        existing.completion_tokens = completion_tokens
        existing.source_text_length = source_text_length
        existing.translated_text_length = translated_text_length
        existing.edited_by_user = edited_by_user
        existing.edited_at = edited_at
        existing.updated_at = datetime.utcnow()
        if user_notes is not None:
            existing.user_notes = user_notes
    else:
        db.add(
            TranslationCache(
                paper_id=paper_id,
                block_id=block_id,
                original_text=original_text,
                translated_text=translated_text,
                mode=mode,
                agent_mode=f"translate:{mode}",
                model_used=model_used or "",
                finish_reason=finish_reason or "",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                source_text_length=source_text_length,
                translated_text_length=translated_text_length,
                edited_by_user=edited_by_user,
                edited_at=edited_at,
                user_notes=user_notes or "",
                updated_at=datetime.utcnow(),
            )
        )


async def _load_page_blocks(paper_id: str, page_number: int) -> list[dict]:
    """从数据库读取指定页的提取块。"""
    async with async_session_factory() as session:
        stmt = (
            select(PaperBlock)
            .where(PaperBlock.paper_id == paper_id, PaperBlock.page_number == page_number)
            .order_by(PaperBlock.created_at.asc())
        )
        rows = (await session.execute(stmt)).scalars().all()
        return [
            {
                "id": row.block_id,
                "text": row.text,
                "block_type": row.block_type,
                "section_title": row.section_title or "",
            }
            for row in rows
        ]


@router.post("")
async def translate(data: dict, db: AsyncSession = Depends(get_db)):
    """翻译（段落/句子）"""
    try:
        logger.info(f"翻译请求: paper_id={data.get('paper_id','')}, mode={data.get('mode','quick')}, "
                     f"text_len={len(data.get('text',''))}")
        request = TranslationRequest(
            paper_id=data.get("paper_id", ""),
            block_id=data.get("block_id", ""),
            text=data.get("text", ""),
            mode=TranslationMode(data.get("mode", "quick")),
            context=data.get("context", ""),
            previous_summary=data.get("previous_summary", ""),
            reference_pages=data.get("reference_pages", ""),
            auxiliary_text=data.get("auxiliary_text", ""),
            skip_cache=bool(data.get("force", False)),
        )
        result = await translation_service.translate(request)
        logger.info(
            "翻译成功: model_used=%s from_cache=%s tokens_used=%s finish_reason=%s source_len=%s output_len=%s retry_count=%s",
            result.model_used,
            result.from_cache,
            result.tokens_used,
            result.finish_reason,
            result.source_text_length,
            result.translated_text_length,
            result.retry_count,
        )

        await _upsert_translation_cache(
            db,
            paper_id=result.paper_id,
            block_id=result.block_id,
            original_text=result.original_text,
            translated_text=result.translated_text,
            mode=result.mode.value,
            model_used=result.model_used,
            finish_reason=result.finish_reason,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
            source_text_length=result.source_text_length,
            translated_text_length=result.translated_text_length,
        )
        await db.commit()

        return {
            "paper_id": result.paper_id,
            "block_id": result.block_id,
            "original_text": result.original_text,
            "translated_text": result.translated_text,
            "mode": result.mode.value,
            "from_cache": result.from_cache,
            "model_used": result.model_used,
            "tokens_used": result.tokens_used,
            "finish_reason": result.finish_reason,
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "source_text_length": result.source_text_length,
            "translated_text_length": result.translated_text_length,
            "retry_count": result.retry_count,
        }
    except TranslationQualityError as e:
        logger.error(
            "翻译结果被拒绝: source_len=%s output_len=%s finish_reason=%s retry_count=%s reason=%s",
            e.source_length,
            e.translated_length,
            e.finish_reason,
            e.retry_count,
            e.reason,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(e),
                "reason": e.reason,
                "source_text_length": e.source_length,
                "translated_text_length": e.translated_length,
                "finish_reason": e.finish_reason,
                "retry_count": e.retry_count,
            },
        )
    except Exception as e:
        logger.error(f"翻译失败: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@router.get("/stream")
async def stream_translate(
    paper_id: str,
    block_id: str,
    text: str,
    mode: str = "quick",
    context: str = "",
    previous_summary: str = "",
    reference_pages: str = "",
    auxiliary_text: str = "",
):
    """SSE 流式翻译"""
    async def event_generator():
        request = TranslationRequest(
            paper_id=paper_id,
            block_id=block_id,
            text=text,
            mode=TranslationMode(mode),
            context=context,
            previous_summary=previous_summary,
            reference_pages=reference_pages,
            auxiliary_text=auxiliary_text,
        )
        async for chunk in translation_service.stream_translate(request):
            yield {"data": chunk}

    return EventSourceResponse(event_generator())


@router.get("/cache/{paper_id}")
async def get_translation_cache(paper_id: str):
    """获取翻译缓存"""
    cached = translation_service.get_cached_for_paper(paper_id)
    return {"paper_id": paper_id, "cache": cached}


@router.get("/cache/{paper_id}/entry")
async def get_translation_cache_entry(
    paper_id: str,
    block_id: str,
    mode: str = "quick",
    db: AsyncSession = Depends(get_db),
):
    """获取单条持久化翻译缓存。"""
    row = (
        await db.execute(
            select(TranslationCache).where(
                TranslationCache.paper_id == paper_id,
                TranslationCache.block_id == block_id,
                TranslationCache.mode == mode,
            )
        )
    ).scalar_one_or_none()
    return {"paper_id": paper_id, "entry": _serialize_cache_row(row)}


@router.post("/page")
async def translate_page(data: dict, db: AsyncSession = Depends(get_db)):
    """整页翻译 - 直接读取后端保存的页级 markdown，翻译后落盘。"""
    try:
        paper_id = data.get("paper_id", "")
        page_number = max(1, int(data.get("page_number", 1) or 1))
        mode = TranslationMode(data.get("mode", "quick"))
        force = bool(data.get("force", False))

        if not paper_id:
            raise HTTPException(status_code=400, detail="缺少 paper_id")
        logger.info(
            "页翻译请求开始: paper_id=%s page=%s mode=%s force=%s request_keys=%s",
            paper_id,
            page_number,
            mode.value,
            force,
            sorted(data.keys()),
        )

        paper = await _load_paper_or_404(db, paper_id)
        page_source = await _load_page_source(db, paper_id, page_number)
        source_markdown = (page_source.get("markdown") or "").strip()
        source_text = page_source.get("text") or ""
        pdfjs_text = data.get("pdfjs_text", "") or ""
        pymupdf_text = _extract_pdf_page_text_with_pymupdf(getattr(paper, "file_path", "") or "", page_number)
        current_page_text, current_text_source = _pick_current_page_text(
            pdfjs_text=pdfjs_text,
            pymupdf_text=pymupdf_text,
            docling_text=source_text,
            docling_markdown=source_markdown,
        )
        logger.info(
            "页翻译源选择: paper_id=%s page=%s current_source=%s current_len=%s pdfjs_len=%s pymupdf_len=%s docling_text_len=%s docling_markdown_len=%s current_sha=%s current_preview=%r",
            paper_id,
            page_number,
            current_text_source or "none",
            len(current_page_text or ""),
            len(_normalize_pdf_page_text(pdfjs_text)),
            len(pymupdf_text or ""),
            len(_normalize_auxiliary_text(source_text)),
            len(source_markdown or ""),
            _text_digest(current_page_text or ""),
            _text_preview(current_page_text or ""),
        )
        if not current_page_text:
            logger.warning(
                "页翻译无可用当前页文本: paper_id=%s page=%s pdfjs_len=%s pymupdf_len=%s docling_text_len=%s docling_markdown_len=%s",
                paper_id,
                page_number,
                len(pdfjs_text or ""),
                len(pymupdf_text or ""),
                len(source_text or ""),
                len(source_markdown or ""),
            )
            return {
                "paper_id": paper_id,
                "page_number": page_number,
                "mode": mode.value,
                "exists": False,
                "source_text": current_page_text,
                "source_markdown": source_markdown,
                "translated_markdown": "",
                "translated_markdown_path": "",
                "previous_summary": "",
                "from_cache": False,
                "model_used": "",
                "tokens_used": 0,
                "finish_reason": "",
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "source_text_length": 0,
                "translated_text_length": 0,
                "retry_count": 0,
                "edited_by_user": False,
                "edited_at": None,
                "user_notes": "",
            }

        translated_path = _paper_translation_page_path(paper_id, mode.value, page_number)
        block_id = f"page-{page_number}-{mode.value}"
        existing = (
            await db.execute(
                select(TranslationCache).where(
                    TranslationCache.paper_id == paper_id,
                    TranslationCache.block_id == block_id,
                    TranslationCache.mode == mode.value,
                )
            )
        ).scalar_one_or_none()
        previous_summary = ""
        reference_pages = _build_reference_pages_context(paper, paper_id, page_number)
        repaired_markdown = _repair_formula_placeholders(
            source_markdown,
            current_page_text,
            source_text,
            pdfjs_text,
            pymupdf_text,
        )
        sanitized_layout, images = _extract_markdown_images(repaired_markdown)
        sanitized_layout, formulas = _extract_markdown_formulas(sanitized_layout)
        auxiliary_text = _build_page_translation_auxiliary(
            layout_markdown=sanitized_layout,
            current_text_source=current_text_source,
        )
        translation_source = f"<!-- page:{page_number} -->\n\n{current_page_text}"
        logger.info(
            "页翻译上下文组装: paper_id=%s page=%s translation_source_len=%s translation_source_sha=%s reference_len=%s auxiliary_len=%s layout_len=%s image_tokens=%s formula_tokens=%s existing_cache=%s translated_path_exists=%s",
            paper_id,
            page_number,
            len(translation_source),
            _text_digest(translation_source),
            len(reference_pages or ""),
            len(auxiliary_text or ""),
            len(sanitized_layout or ""),
            len(images),
            len(formulas),
            bool(existing),
            translated_path.exists(),
        )

        if (
            not force
            and translated_path.exists()
            and existing
            and (
                bool(existing.edited_by_user)
                or (existing.original_text or "").strip() == translation_source.strip()
            )
        ):
            translated_markdown = translated_path.read_text(encoding="utf-8")
            logger.info(
                "页翻译持久化缓存命中: paper_id=%s page=%s mode=%s translated_len=%s finish_reason=%s source_sha=%s translated_sha=%s",
                paper_id,
                page_number,
                mode.value,
                len(translated_markdown or ""),
                existing.finish_reason if existing else "",
                _text_digest(existing.original_text if existing else ""),
                _text_digest(translated_markdown or ""),
            )
            return {
                "paper_id": paper_id,
                "page_number": page_number,
                "mode": mode.value,
                "exists": True,
                "source_text": current_page_text,
                "source_markdown": repaired_markdown,
                "translated_markdown": translated_markdown,
                "translated_markdown_path": str(translated_path),
                "previous_summary": previous_summary,
                "from_cache": True,
                "model_used": existing.model_used if existing else "",
                "tokens_used": 0,
                "finish_reason": existing.finish_reason if existing else "",
                "prompt_tokens": existing.prompt_tokens if existing else 0,
                "completion_tokens": existing.completion_tokens if existing else 0,
                "source_text_length": existing.source_text_length if existing else len(translation_source),
                "translated_text_length": existing.translated_text_length if existing else len(translated_markdown),
                "retry_count": 0,
                "edited_by_user": existing.edited_by_user if existing else False,
                "edited_at": existing.edited_at.isoformat() if existing and existing.edited_at else None,
                "user_notes": existing.user_notes if existing else "",
            }
        if not force and translated_path.exists():
            logger.warning(
                "页翻译持久化缓存过期，将重新翻译: paper_id=%s page=%s mode=%s existing_source_sha=%s current_source_sha=%s existing_source_len=%s current_source_len=%s has_db_cache=%s",
                paper_id,
                page_number,
                mode.value,
                _text_digest(existing.original_text if existing else ""),
                _text_digest(translation_source),
                len(existing.original_text or "") if existing else 0,
                len(translation_source),
                bool(existing),
            )

        request = TranslationRequest(
            paper_id=paper_id,
            block_id=block_id,
            text=translation_source,
            mode=mode,
            context=(
                f"{paper.title or '文档'} 第 {page_number} 页全文。"
                f"当前页主文本来源：{current_text_source}。"
                "只翻译原文区当前页，不翻译相邻页参考。"
            ),
            previous_summary=previous_summary,
            reference_pages=reference_pages,
            auxiliary_text=auxiliary_text,
            skip_cache=force,
        )
        result = await translation_service.translate(request)
        translated_markdown = _restore_markdown_tokens(result.translated_text, formulas)
        translated_markdown = _restore_markdown_images(translated_markdown, images)
        logger.info(
            "页翻译 LLM 完成: paper_id=%s page=%s mode=%s from_cache=%s model=%s finish_reason=%s tokens=%s prompt_tokens=%s completion_tokens=%s source_len=%s llm_output_len=%s restored_len=%s retry_count=%s restored_sha=%s restored_preview=%r",
            paper_id,
            page_number,
            mode.value,
            result.from_cache,
            result.model_used,
            result.finish_reason,
            result.tokens_used,
            result.prompt_tokens,
            result.completion_tokens,
            result.source_text_length,
            result.translated_text_length,
            len(translated_markdown or ""),
            result.retry_count,
            _text_digest(translated_markdown or ""),
            _text_preview(translated_markdown or ""),
        )
        translated_markdown_path = _persist_translated_markdown(
            paper_id,
            mode.value,
            page_number,
            translated_markdown,
        )
        await _upsert_translation_cache(
            db,
            paper_id=paper_id,
            block_id=block_id,
            original_text=translation_source,
            translated_text=translated_markdown,
            mode=mode.value,
            model_used=result.model_used,
            finish_reason=result.finish_reason,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
            source_text_length=result.source_text_length,
            translated_text_length=len(translated_markdown),
        )
        await db.commit()
        logger.info(
            "页翻译已落盘: paper_id=%s page=%s mode=%s path=%s translated_len=%s source_sha=%s translated_sha=%s",
            paper_id,
            page_number,
            mode.value,
            translated_markdown_path,
            len(translated_markdown or ""),
            _text_digest(translation_source),
            _text_digest(translated_markdown or ""),
        )

        return {
            "paper_id": paper_id,
            "page_number": page_number,
            "mode": mode.value,
            "exists": True,
            "source_text": current_page_text,
            "source_markdown": repaired_markdown,
            "translated_markdown": translated_markdown,
            "translated_markdown_path": translated_markdown_path,
            "previous_summary": previous_summary,
            "from_cache": result.from_cache,
            "model_used": result.model_used,
            "tokens_used": result.tokens_used,
            "finish_reason": result.finish_reason,
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "source_text_length": result.source_text_length,
            "translated_text_length": len(translated_markdown),
            "retry_count": result.retry_count,
            "edited_by_user": False,
            "edited_at": None,
            "user_notes": existing.user_notes if existing else "",
        }
    except TranslationQualityError as e:
        logger.error(
            "页翻译结果被拒绝: paper_id=%s page=%s source_len=%s output_len=%s finish_reason=%s retry_count=%s reason=%s",
            data.get("paper_id", ""),
            data.get("page_number", 1),
            e.source_length,
            e.translated_length,
            e.finish_reason,
            e.retry_count,
            e.reason,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": str(e),
                "reason": e.reason,
                "source_text_length": e.source_length,
                "translated_text_length": e.translated_length,
                "finish_reason": e.finish_reason,
                "retry_count": e.retry_count,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/page")
async def update_translated_page(data: dict, db: AsyncSession = Depends(get_db)):
    """保存用户手动修订后的页级译文，不调用 LLM。"""
    paper_id = data.get("paper_id", "")
    page_number = max(1, int(data.get("page_number", 1) or 1))
    mode = data.get("mode", "quick")
    translated_markdown = data.get("translated_markdown", "")
    notes_provided = "user_notes" in data
    user_notes = data.get("user_notes", "") if notes_provided else None

    if not paper_id:
        raise HTTPException(status_code=400, detail="缺少 paper_id")
    if mode not in {"quick", "polish"}:
        raise HTTPException(status_code=400, detail="无效翻译模式")
    if not isinstance(translated_markdown, str) or not translated_markdown.strip():
        raise HTTPException(status_code=400, detail="译文不能为空")

    paper = await _load_paper_or_404(db, paper_id)
    page_source = await _load_page_source(db, paper_id, page_number)
    pymupdf_text = _extract_pdf_page_text_with_pymupdf(getattr(paper, "file_path", "") or "", page_number)
    current_page_text, _ = _pick_current_page_text(
        pymupdf_text=pymupdf_text,
        docling_text=page_source.get("text") or "",
        docling_markdown=page_source.get("markdown") or "",
    )
    translation_source = f"<!-- page:{page_number} -->\n\n{current_page_text}" if current_page_text else ""
    block_id = f"page-{page_number}-{mode}"
    existing = (
        await db.execute(
            select(TranslationCache).where(
                TranslationCache.paper_id == paper_id,
                TranslationCache.block_id == block_id,
                TranslationCache.mode == mode,
            )
        )
    ).scalar_one_or_none()
    original_text = existing.original_text if existing and existing.original_text else translation_source
    edited_at = datetime.utcnow()

    translated_markdown_path = _persist_translated_markdown(
        paper_id,
        mode,
        page_number,
        translated_markdown,
    )
    await _upsert_translation_cache(
        db,
        paper_id=paper_id,
        block_id=block_id,
        original_text=original_text,
        translated_text=translated_markdown,
        mode=mode,
        model_used=existing.model_used if existing else "",
        finish_reason=existing.finish_reason if existing else "user_edit",
        prompt_tokens=existing.prompt_tokens if existing else 0,
        completion_tokens=existing.completion_tokens if existing else 0,
        source_text_length=len(original_text or ""),
        translated_text_length=len(translated_markdown),
        edited_by_user=True,
        edited_at=edited_at,
        user_notes=user_notes if notes_provided else (existing.user_notes if existing else ""),
    )
    await db.commit()
    logger.info(
        "页译文人工修订已保存: paper_id=%s page=%s mode=%s translated_len=%s translated_sha=%s notes_len=%s path=%s",
        paper_id,
        page_number,
        mode,
        len(translated_markdown or ""),
        _text_digest(translated_markdown or ""),
        len((user_notes if notes_provided else (existing.user_notes if existing else "")) or ""),
        translated_markdown_path,
    )

    return {
        "paper_id": paper_id,
        "page_number": page_number,
        "mode": mode,
        "exists": True,
        "source_text": current_page_text,
        "source_markdown": page_source.get("markdown") or "",
        "translated_markdown": translated_markdown,
        "translated_markdown_path": translated_markdown_path,
        "previous_summary": _build_previous_summary(paper_id, mode, page_number),
        "from_cache": True,
        "model_used": existing.model_used if existing else "",
        "tokens_used": 0,
        "finish_reason": existing.finish_reason if existing else "user_edit",
        "prompt_tokens": existing.prompt_tokens if existing else 0,
        "completion_tokens": existing.completion_tokens if existing else 0,
        "source_text_length": len(original_text or ""),
        "translated_text_length": len(translated_markdown),
        "retry_count": 0,
        "edited_by_user": True,
        "edited_at": edited_at.isoformat(),
        "user_notes": user_notes if notes_provided else (existing.user_notes if existing else ""),
    }


@router.get("/page")
async def get_translated_page(
    paper_id: str,
    page_number: int,
    mode: str = "quick",
    db: AsyncSession = Depends(get_db),
):
    """读取已落盘的页级译文。"""
    page_number = max(1, page_number)
    paper = await _load_paper_or_404(db, paper_id)
    page_source = await _load_page_source(db, paper_id, page_number)
    pymupdf_text = _extract_pdf_page_text_with_pymupdf(getattr(paper, "file_path", "") or "", page_number)
    current_page_text, _ = _pick_current_page_text(
        pymupdf_text=pymupdf_text,
        docling_text=page_source.get("text") or "",
        docling_markdown=page_source.get("markdown") or "",
    )
    repaired_markdown = _repair_formula_placeholders(
        page_source.get("markdown") or "",
        current_page_text,
        page_source.get("text") or "",
        pymupdf_text,
    )
    translated_path = _paper_translation_page_path(paper_id, mode, page_number)
    block_id = f"page-{page_number}-{mode}"
    existing = (
        await db.execute(
            select(TranslationCache).where(
                TranslationCache.paper_id == paper_id,
                TranslationCache.block_id == block_id,
                TranslationCache.mode == mode,
            )
        )
    ).scalar_one_or_none()
    translation_source = f"<!-- page:{page_number} -->\n\n{current_page_text}" if current_page_text else ""
    source_matches_cache = (
        existing is not None
        and bool(translation_source)
        and (existing.original_text or "").strip() == translation_source.strip()
    )
    has_persisted_translation = translated_path.exists() and (
        existing is not None or bool(translated_path.read_text(encoding="utf-8").strip())
    )
    logger.info(
        "读取页译文: paper_id=%s page=%s mode=%s exists=%s path_exists=%s has_db_cache=%s source_matches_cache=%s edited_by_user=%s current_source_len=%s current_source_sha=%s cached_source_sha=%s translated_len=%s",
        paper_id,
        page_number,
        mode,
        has_persisted_translation,
        translated_path.exists(),
        bool(existing),
        source_matches_cache,
        bool(existing.edited_by_user) if existing else False,
        len(translation_source or ""),
        _text_digest(translation_source or ""),
        _text_digest(existing.original_text if existing else ""),
        len(translated_path.read_text(encoding="utf-8")) if translated_path.exists() else 0,
    )
    return {
        "paper_id": paper_id,
        "page_number": page_number,
        "mode": mode,
        "exists": has_persisted_translation,
        "source_text": current_page_text,
        "source_markdown": repaired_markdown,
        "translated_markdown": translated_path.read_text(encoding="utf-8") if has_persisted_translation else "",
        "translated_markdown_path": str(translated_path) if has_persisted_translation else "",
        "previous_summary": _build_previous_summary(paper_id, mode, page_number),
        "from_cache": has_persisted_translation,
        "model_used": existing.model_used if existing else "",
        "tokens_used": 0,
        "finish_reason": existing.finish_reason if existing else "",
        "prompt_tokens": existing.prompt_tokens if existing else 0,
        "completion_tokens": existing.completion_tokens if existing else 0,
        "source_text_length": existing.source_text_length if existing else len(repaired_markdown),
        "translated_text_length": existing.translated_text_length if existing else (
            len(translated_path.read_text(encoding="utf-8")) if has_persisted_translation else 0
        ),
        "retry_count": 0,
        "edited_by_user": existing.edited_by_user if existing else False,
        "edited_at": existing.edited_at.isoformat() if existing and existing.edited_at else None,
        "user_notes": existing.user_notes if existing else "",
        "source_matches_cache": source_matches_cache,
        "document_type": getattr(paper, "document_type", "document"),
        "block_count": (
            await db.execute(
                select(func.count())
                .select_from(PaperBlock)
                .where(PaperBlock.paper_id == paper_id, PaperBlock.page_number == page_number)
            )
        ).scalar() or 0,
    }
