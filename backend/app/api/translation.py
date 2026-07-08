"""翻译 API"""
import traceback
import logging
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse
from app.database import async_session_factory, get_db
from app.models.paper_block import PaperBlock
from app.models.translation_cache import TranslationCache
from app.services.translation import translation_service, TranslationRequest, TranslationMode
from app.services.pdf import pdf_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/translate", tags=["翻译"])


async def _load_page_blocks(paper_id: str, page_number: int) -> list[dict]:
    """优先从内存缓存取页面块，缓存没有时回退到数据库。"""
    blocks = pdf_service.get_blocks(paper_id, page_number=page_number)
    if blocks:
        return [
            {
                "id": block.id,
                "text": block.text,
                "block_type": block.block_type.value,
                "section_title": block.section_title or "",
            }
            for block in blocks
        ]

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
        )
        result = await translation_service.translate(request)
        logger.info(f"翻译成功: model_used={result.model_used}, from_cache={result.from_cache}, "
                     f"tokens_used={result.tokens_used}")

        existing = (
            await db.execute(
                select(TranslationCache).where(
                    TranslationCache.paper_id == result.paper_id,
                    TranslationCache.block_id == result.block_id,
                    TranslationCache.mode == result.mode.value,
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.original_text = result.original_text
            existing.translated_text = result.translated_text
            existing.agent_mode = f"translate:{result.mode.value}"
            existing.model_used = result.model_used or existing.model_used
        else:
            db.add(
                TranslationCache(
                    paper_id=result.paper_id,
                    block_id=result.block_id,
                    original_text=result.original_text,
                    translated_text=result.translated_text,
                    mode=result.mode.value,
                    agent_mode=f"translate:{result.mode.value}",
                    model_used=result.model_used or "",
                )
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
        }
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
):
    """SSE 流式翻译"""
    async def event_generator():
        request = TranslationRequest(
            paper_id=paper_id,
            block_id=block_id,
            text=text,
            mode=TranslationMode(mode),
            context=context,
        )
        async for chunk in translation_service.stream_translate(request):
            yield {"data": chunk}

    return EventSourceResponse(event_generator())


@router.get("/cache/{paper_id}")
async def get_translation_cache(paper_id: str):
    """获取翻译缓存"""
    cached = translation_service.get_cached_for_paper(paper_id)
    return {"paper_id": paper_id, "cache": cached}


@router.post("/page")
async def translate_page(data: dict):
    """整页翻译 - 翻译指定页面的所有文本块"""
    try:
        paper_id = data.get("paper_id", "")
        page_number = data.get("page_number", 1)
        mode = data.get("mode", "quick")

        if not paper_id:
            raise HTTPException(status_code=400, detail="缺少 paper_id")

        blocks = await _load_page_blocks(paper_id, page_number)
        translatable_types = {"paragraph", "heading"}
        text_blocks = [
            block for block in blocks
            if block["block_type"] in translatable_types and block["text"].strip()
        ]

        if not text_blocks:
            return {
                "paper_id": paper_id,
                "page_number": page_number,
                "blocks": [],
                "total_blocks": 0,
                "cached_blocks": 0,
                "model_used": "",
            }

        results = []
        cached_count = 0
        model_used = ""

        for block in text_blocks:
            request = TranslationRequest(
                paper_id=paper_id,
                block_id=block["id"],
                text=block["text"],
                mode=TranslationMode(mode),
                context=block["section_title"],
            )
            result = await translation_service.translate(request)
            results.append({
                "block_id": block["id"],
                "original_text": result.original_text,
                "translated_text": result.translated_text,
                "from_cache": result.from_cache,
            })
            if result.from_cache:
                cached_count += 1
            if result.model_used:
                model_used = result.model_used

        return {
            "paper_id": paper_id,
            "page_number": page_number,
            "blocks": results,
            "total_blocks": len(text_blocks),
            "cached_blocks": cached_count,
            "model_used": model_used,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
