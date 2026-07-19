"""最小可用论文摄入管线"""
import json

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.models.paper_chunk import PaperChunk
from app.models.translation_cache import TranslationCache
from app.services.docling import docling_service
from app.services.ingestion.vector_index import VectorIndexEntry
from app.services.ingestion.vector_index import vector_index_service


class PaperIngestionService:
    """上传后的解析与索引闭环"""

    def __init__(self):
        pass

    async def ingest(self, paper: Paper, db: AsyncSession) -> dict:
        source_ref = (paper.file_path or "").strip() or (getattr(paper, "source_url", "") or "").strip()
        if not source_ref:
            raise ValueError("paper 缺少可提取的 source_ref")

        paper_dir = settings.PAPERS_DIR / paper.id
        extraction = docling_service.extract(
            source_ref,
            paper_id=paper.id,
            artifact_dir=paper_dir / "artifacts",
            asset_url_prefix=f"/api/papers/{paper.id}/artifacts",
        )
        blocks = extraction.pdf_document.all_blocks if extraction.pdf_document else []
        chunks = extraction.chunks
        page_translations = await self._load_page_translations(db, paper.id)

        await db.execute(delete(PaperBlock).where(PaperBlock.paper_id == paper.id))
        await db.execute(delete(PaperChunk).where(PaperChunk.paper_id == paper.id))

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

        db.add_all(
            [
                PaperChunk(
                    paper_id=paper.id,
                    chunk_id=chunk.chunk_id,
                    page_number=chunk.page_number,
                    block_id=chunk.block_id,
                    text=chunk.text,
                    metadata_json=json.dumps(chunk.metadata),
                )
                for chunk in chunks
            ]
        )

        if getattr(paper, "markdown_path", ""):
            try:
                with open(paper.markdown_path, "w", encoding="utf-8") as handle:
                    handle.write(extraction.markdown or "")
            except Exception:
                pass
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
                    **extraction.metadata,
                    "page_sources": [
                        {
                            "page_number": page.page_number,
                            "text": page.text,
                            "markdown": page.markdown,
                        }
                        for page in extraction.page_sources
                    ],
                },
                ensure_ascii=False,
            )
        if getattr(paper, "document_type", "") != extraction.source_type:
            paper.document_type = extraction.source_type

        paper.is_indexed = bool(chunks)
        await db.commit()
        await vector_index_service.upsert_entries(
            paper.id,
            [
                VectorIndexEntry(
                    chunk_id=chunk.chunk_id,
                    paper_id=paper.id,
                    page=chunk.page_number,
                    section_title=str(chunk.metadata.get("section_title", "") or ""),
                    text=self._build_vector_text(
                        paper=paper,
                        chunk_text=chunk.text,
                        page_number=chunk.page_number,
                        section_title=str(chunk.metadata.get("section_title", "") or ""),
                        translated_page_text=page_translations.get(chunk.page_number, ""),
                    ),
                )
                for chunk in chunks
            ],
        )

        return {
            "paper_id": paper.id,
            "blocks": len(blocks),
            "chunks": len(chunks),
            "is_indexed": paper.is_indexed,
        }

    async def rebuild_vector_index(self, paper: Paper, db: AsyncSession) -> dict:
        chunk_rows = (
            await db.execute(
                select(PaperChunk).where(PaperChunk.paper_id == paper.id).order_by(PaperChunk.page_number.asc())
            )
        ).scalars().all()
        page_translations = await self._load_page_translations(db, paper.id)
        await vector_index_service.upsert_entries(
            paper.id,
            [
                VectorIndexEntry(
                    chunk_id=row.chunk_id,
                    paper_id=paper.id,
                    page=row.page_number,
                    section_title=json.loads(row.metadata_json or "{}").get("section_title", ""),
                    text=self._build_vector_text(
                        paper=paper,
                        chunk_text=row.text,
                        page_number=row.page_number,
                        section_title=json.loads(row.metadata_json or "{}").get("section_title", ""),
                        translated_page_text=page_translations.get(row.page_number, ""),
                    ),
                )
                for row in chunk_rows
            ],
        )
        return {
            "paper_id": paper.id,
            "chunks": len(chunk_rows),
        }

    async def _load_page_translations(self, db: AsyncSession, paper_id: str) -> dict[int, str]:
        rows = (
            await db.execute(
                select(TranslationCache.block_id, TranslationCache.translated_text)
                .where(
                    TranslationCache.paper_id == paper_id,
                    TranslationCache.mode == "quick",
                )
            )
        ).all()
        page_translations: dict[int, str] = {}
        for block_id, translated_text in rows:
            if not block_id.startswith("page-"):
                continue
            try:
                page_number = int(block_id.split("-")[1])
            except Exception:
                continue
            page_translations[page_number] = translated_text or ""
        return page_translations

    def _build_vector_text(
        self,
        *,
        paper: Paper,
        chunk_text: str,
        page_number: int,
        section_title: str,
        translated_page_text: str,
    ) -> str:
        # Keep vector inputs chunk-centric. Repeating whole-paper abstract/summary/page
        # text for every chunk collapses many embeddings toward the same paper-level
        # representation and hurts chunk retrieval quality.
        translated_snippet = (translated_page_text or "").strip()[:240]
        structured_parts = [
            f"title: {paper.title}" if paper.title else "",
            f"section: {section_title}" if section_title else "",
            f"page: {page_number}",
            f"chunk: {chunk_text}" if chunk_text else "",
            f"translation_hint: {translated_snippet}" if translated_snippet else "",
        ]
        return "\n".join(part for part in structured_parts if part)


paper_ingestion_service = PaperIngestionService()
