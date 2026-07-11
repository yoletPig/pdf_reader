"""最小可用论文摄入管线"""
import json

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.paper import Paper
from app.models.paper_block import PaperBlock
from app.models.paper_chunk import PaperChunk
from app.services.pdf import pdf_service
from app.services.ingestion.chunker import ChunkSplitter


class PaperIngestionService:
    """上传后的解析与索引闭环"""

    def __init__(self):
        self._splitter = ChunkSplitter()

    async def ingest(self, paper: Paper, db: AsyncSession) -> dict:
        pdf_doc = await pdf_service.parse_pdf(paper.id, paper.file_path)
        blocks = pdf_doc.all_blocks
        chunks = self._splitter.split_blocks(blocks, paper_id=paper.id)

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

        return {
            "paper_id": paper.id,
            "blocks": len(blocks),
            "chunks": len(chunks),
            "is_indexed": paper.is_indexed,
        }


paper_ingestion_service = PaperIngestionService()
