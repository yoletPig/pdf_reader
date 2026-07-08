"""论文摄入管线（解析→分块→向量化→图谱）"""
import time
import os
from pathlib import Path
from typing import Optional
from app.config import settings
from app.services.knowledge_base.types import PaperIngestionResult


class PaperIngestionPipeline:
    """论文摄入管线"""

    def __init__(self):
        self._pdf_service = None
        self._rag_engine = None

    def set_services(self, pdf_service, rag_engine):
        """注入服务依赖"""
        self._pdf_service = pdf_service
        self._rag_engine = rag_engine

    async def ingest(self, paper_id: str, file_path: str, title: str = "") -> PaperIngestionResult:
        """
        摄入论文：解析 PDF → 分块 → 向量化 → 图谱构建
        """
        start_time = time.time()

        try:
            if not self._pdf_service:
                raise RuntimeError("PDF 服务未注入")
            if not self._rag_engine:
                raise RuntimeError("RAG 引擎未注入")

            # 1. 解析 PDF
            pdf_doc = await self._pdf_service.parse_pdf(paper_id, file_path)
            blocks = pdf_doc.all_blocks

            # 2. 索引到 RAG 引擎（分块 + BM25 + 向量化）
            await self._rag_engine.index_paper(paper_id, title, blocks)

            duration = time.time() - start_time

            return PaperIngestionResult(
                paper_id=paper_id,
                success=True,
                chunks_created=len(blocks),
                duration_seconds=duration,
            )

        except Exception as e:
            duration = time.time() - start_time
            return PaperIngestionResult(
                paper_id=paper_id,
                success=False,
                error=str(e),
                duration_seconds=duration,
            )


# 全局单例
ingestion_pipeline = PaperIngestionPipeline()
