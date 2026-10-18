"""论文摄入管线 - 仅解析与 block 落库，无向量索引"""
import asyncio
import json
import logging

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.services import settings_store
from app.services.pymupdf import pymupdf_service

logger = logging.getLogger(__name__)


class PaperIngestionService:
    """上传后的解析闭环：解析（pymupdf/docling 可选）→ blocks 落库 → markdown 落盘。

    向量切分与向量检索已移除，问答检索由 agent-gateway (pi agent) 负责。
    """

    def __init__(self):
        pass

    def _resolve_engine(self) -> str:
        return settings_store.current_pdf_engine()

    def _extract_sync(self, source_ref: str, paper_id: str, paper_dir):
        """同步解析（在线程池中执行）。"""
        engine = self._resolve_engine()
        if engine == "docling":
            from app.services.docling import docling_service
            return docling_service.extract(
                source_ref,
                paper_id=paper_id,
                artifact_dir=paper_dir / "artifacts",
                asset_url_prefix=f"/api/papers/{paper_id}/artifacts",
            )
        return pymupdf_service.extract(
            source_ref,
            paper_id=paper_id,
            artifact_dir=paper_dir / "artifacts",
        )

    async def ingest(self, paper: Paper, db: AsyncSession) -> dict:
        source_ref = (paper.file_path or "").strip() or (getattr(paper, "source_url", "") or "").strip()
        if not source_ref:
            raise ValueError("paper 缺少可提取的 source_ref")

        paper_dir = settings.PAPERS_DIR / paper.id
        # 重 CPU/IO 解析放入线程池，避免阻塞事件循环
        extraction = await asyncio.to_thread(
            self._extract_sync, source_ref, paper.id, paper_dir
        )

        blocks = extraction.pdf_document.all_blocks if extraction.pdf_document else []

        await db.execute(delete(PaperBlock).where(PaperBlock.paper_id == paper.id))
        db.add_all(
            [
                PaperBlock(
                    paper_id=paper.id,
                    block_id=block.id,
                    page_number=block.page,
                    text=block.text,
                    block_type=block.block_type.value,
                    bbox_json=json.dumps(list(block.bbox or (0.0, 0.0, 0.0, 0.0))),
                    section_title=block.section_title or "",
                )
                for block in blocks
            ]
        )

        if getattr(paper, "markdown_path", ""):
            try:
                def _write_markdown(path: str, content: str):
                    with open(path, "w", encoding="utf-8") as handle:
                        handle.write(content or "")
                await asyncio.to_thread(_write_markdown, paper.markdown_path, extraction.markdown or "")
            except Exception:
                logger.warning("写入 markdown 失败: paper=%s", paper.id, exc_info=True)

        page_sources_dir = paper_dir / "page_sources"
        page_sources_dir.mkdir(parents=True, exist_ok=True)
        for page_source in extraction.page_sources:
            try:
                (page_sources_dir / f"page-{page_source.page_number:04d}.md").write_text(page_source.markdown or "", encoding="utf-8")
                (page_sources_dir / f"page-{page_source.page_number:04d}.txt").write_text(page_source.text or "", encoding="utf-8")
            except Exception:
                pass

        if extraction.page_count and extraction.page_count != (paper.page_count or 0):
            paper.page_count = extraction.page_count
        if extraction.metadata:
            current = json.loads(paper.pdf_metadata_json or "{}") if (paper.pdf_metadata_json or "").strip() else {}
            paper.pdf_metadata_json = json.dumps(
                {
                    **current,
                    **{k: v for k, v in extraction.metadata.items() if k != "page_sources"},
                },
                ensure_ascii=False,
            )
        if getattr(paper, "document_type", "") != extraction.source_type:
            paper.document_type = extraction.source_type

        # blocks 即"已解析"标记（不再有向量索引）
        paper.is_indexed = bool(blocks)
        await db.commit()

        return {
            "paper_id": paper.id,
            "blocks": len(blocks),
            "chunks": 0,
            "is_indexed": paper.is_indexed,
        }


paper_ingestion_service = PaperIngestionService()
