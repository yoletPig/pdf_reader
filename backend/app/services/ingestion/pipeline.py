"""最小可用论文摄入管线"""
import json

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.models.paper_chunk import PaperChunk
from app.models.translation_cache import TranslationCache
from app.services.pdf import pdf_service
from app.services.ingestion.chunker import ChunkSplitter
from app.services.ingestion.vector_index import VectorIndexEntry
from app.services.ingestion.vector_index import vector_index_service


class PaperIngestionService:
    """上传后的解析与索引闭环"""

    def __init__(self):
        self._splitter = ChunkSplitter()

    async def ingest(self, paper: Paper, db: AsyncSession) -> dict:
        pdf_doc = await pdf_service.parse_pdf(paper.id, paper.file_path)
        blocks = pdf_doc.all_blocks
        chunks = self._splitter.split_blocks(blocks, paper_id=paper.id)
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
                    bbox_json=json.dumps(list(block.bbox)),
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
        return "\n".join(
            part
            for part in [
                paper.title or "",
                paper.abstract or "",
                section_title or "",
                chunk_text or "",
                translated_page_text or "",
                paper.ai_summary_md or "",
                f"page {page_number}",
            ]
            if part
        )


paper_ingestion_service = PaperIngestionService()
