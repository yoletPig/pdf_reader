"""知识库管理模块"""
from app.services.knowledge_base.manager import KnowledgeBaseManager, kb_manager
from app.services.knowledge_base.types import KnowledgeBaseStats, PaperIngestionResult

__all__ = [
    "KnowledgeBaseManager",
    "kb_manager",
    "KnowledgeBaseStats",
    "PaperIngestionResult",
]
