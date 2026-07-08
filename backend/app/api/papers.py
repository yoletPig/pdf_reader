"""论文管理 API"""
import os
import re
import uuid
import shutil
import json
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.database import get_db
from app.config import settings
from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.models.paper_chunk import PaperChunk
from app.models.translation_cache import TranslationCache
from app.services.ingestion import paper_ingestion_service
from app.services.llm import LLMMessage, LLMRequest, llm_router

router = APIRouter(prefix="/api/papers", tags=["论文管理"])

# 内存存储（后续可替换为数据库查询）
_papers_store: dict[str, dict] = {}


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
        "file_path": p.file_path,
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


def _sync_memory_store(paper_data: dict):
    _papers_store[paper_data["id"]] = paper_data


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
    page_size: int = 20,
    tag: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """获取论文列表"""
    try:
        stmt = select(Paper).order_by(Paper.added_at.desc())
        if tag:
            stmt = stmt.where(Paper.tags.contains(tag))
        stmt = stmt.offset((page - 1) * page_size).limit(page_size)

        result = await db.execute(stmt)
        papers = result.scalars().all()

        # count
        from sqlalchemy import func
        count_stmt = select(func.count(Paper.id))
        if tag:
            count_stmt = count_stmt.where(Paper.tags.contains(tag))
        total_result = await db.execute(count_stmt)
        total = total_result.scalar() or 0

        return {
            "papers": [_paper_to_dict(p) for p in papers],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    except Exception as e:
        # 数据库不可用时回退到内存存储
        papers = list(_papers_store.values())
        papers.sort(key=lambda p: p.get("added_at", ""), reverse=True)
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
    """上传 PDF 文件"""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")

    paper_id = str(uuid.uuid4())

    # 创建论文目录
    paper_dir = settings.PAPERS_DIR / paper_id
    paper_dir.mkdir(parents=True, exist_ok=True)

    # 保存文件
    safe_filename = file.filename.replace("/", "_").replace("\\", "_")
    file_path = paper_dir / safe_filename
    content = await file.read()

    with open(file_path, "wb") as f:
        f.write(content)

    file_size = len(content)

    # 提取标题（从文件名）
    title = os.path.splitext(file.filename)[0]

    # 尝试解析 PDF 获取元数据
    abstract = ""
    page_count = 0
    pdf_metadata: dict[str, str] = {}
    try:
        import fitz
        doc = fitz.open(file_path)
        page_count = len(doc)
        # 尝试从 PDF 元数据获取标题
        meta = doc.metadata
        pdf_metadata = {
            key: str(value)
            for key, value in (meta or {}).items()
            if value not in (None, "")
        }
        if meta and meta.get("title"):
            title = meta["title"]
        # 提取第一页文本作为摘要
        if page_count > 0:
            abstract = doc[0].get_text()[:1000]
        doc.close()
    except ImportError:
        abstract = f"文件大小: {file_size} bytes"
    except Exception as e:
        abstract = f"PDF 解析失败: {str(e)[:200]}"

    paper_data = {
        "id": paper_id,
        "title": title,
        "authors": "[]",
        "abstract": abstract,
        "year": datetime.utcnow().year,
        "source": "local",
        "source_id": "",
        "file_path": str(file_path),
        "tags": "[]",
        "page_count": page_count,
        "pdf_metadata": pdf_metadata,
        "ai_summary_md": "",
        "reader_profile": {
            "auto_full_translation_enabled": False,
            "auto_full_translation_mode": "quick",
            "auto_full_translation_status": "idle",
            "translated_pages": 0,
            "failed_pages": [],
            "last_summary_refresh_at": None,
        },
        "added_at": datetime.utcnow().isoformat(),
        "last_read_at": None,
        "read_progress": 0.0,
        "is_indexed": False,
    }

    # 存入数据库
    try:
        paper = Paper(
            id=paper_id,
            title=title,
            authors="[]",
            abstract=abstract,
            year=datetime.utcnow().year,
            source="local",
            source_id="",
            file_path=str(file_path),
            tags="[]",
            page_count=page_count,
            pdf_metadata_json=json.dumps(pdf_metadata, ensure_ascii=False),
            ai_summary_md="",
            reader_profile_json=json.dumps(paper_data["reader_profile"], ensure_ascii=False),
            added_at=datetime.utcnow(),
            read_progress=0.0,
            is_indexed=False,
        )
        db.add(paper)
        await db.commit()
        await db.refresh(paper)
        ingestion_result = await paper_ingestion_service.ingest(paper, db)
        paper_data["is_indexed"] = ingestion_result["is_indexed"]
    except Exception:
        pass  # 数据库不可用时仅用内存存储

    # 内存存储
    _sync_memory_store(paper_data)

    return {
        "message": "上传成功",
        "paper": paper_data,
    }


@router.get("/{paper_id}")
async def get_paper(paper_id: str, db: AsyncSession = Depends(get_db)):
    """获取论文详情"""
    # 先查内存
    if paper_id in _papers_store:
        return _papers_store[paper_id]

    # 再查数据库
    try:
        result = await db.execute(select(Paper).where(Paper.id == paper_id))
        paper = result.scalar_one_or_none()
        if paper:
            return _paper_to_dict(paper)
    except Exception:
        pass

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


@router.get("/{paper_id}/file")
async def get_paper_file(paper_id: str):
    """获取 PDF 文件（供前端渲染）"""
    # 查找文件路径
    paper_dir = settings.PAPERS_DIR / paper_id
    if paper_dir.exists():
        pdf_files = list(paper_dir.glob("*.pdf"))
        if pdf_files:
            return FileResponse(
                path=str(pdf_files[0]),
                media_type="application/pdf",
                filename=pdf_files[0].name,
            )

    raise HTTPException(status_code=404, detail="PDF 文件不存在")


@router.get("/{paper_id}/blocks")
async def get_paper_blocks(paper_id: str, page: Optional[int] = None):
    """获取解析后的文本块"""
    from app.services.pdf import pdf_service

    blocks = pdf_service.get_blocks(paper_id, page_number=page)
    if not blocks:
        from app.database import async_session_factory

        async with async_session_factory() as session:
            stmt = select(PaperBlock).where(PaperBlock.paper_id == paper_id).order_by(PaperBlock.page_number.asc())
            if page is not None:
                stmt = stmt.where(PaperBlock.page_number == page)
            rows = (await session.execute(stmt)).scalars().all()
            return {
                "paper_id": paper_id,
                "blocks": [
                    {
                        "id": row.block_id,
                        "text": row.text,
                        "page": row.page_number,
                        "bbox": json.loads(row.bbox_json or "[]"),
                        "block_type": row.block_type,
                        "section_title": row.section_title,
                    }
                    for row in rows
                ],
            }

    return {
        "paper_id": paper_id,
        "blocks": [
            {
                "id": b.id,
                "text": b.text,
                "page": b.page,
                "bbox": list(b.bbox),
                "block_type": b.block_type.value,
                "section_title": b.section_title,
            }
            for b in blocks
        ],
    }
