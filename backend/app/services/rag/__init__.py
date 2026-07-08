"""
PDF Reader RAG 知识库引擎模块
"""

from app.services.rag.types import (
    Chunk,
    RAGResult,
    RetrievalItem,
    RetrievalMode,
    Source,
)
from app.services.rag.engine import RAGEngine

# 全局单例
rag_engine = RAGEngine()

__all__ = [
    "RAGEngine",
    "rag_engine",
    "Chunk",
    "RAGResult",
    "RetrievalItem",
    "RetrievalMode",
    "Source",
]
