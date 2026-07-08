"""知识库相关类型"""
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class KnowledgeBaseStats:
    """知识库统计"""
    total_papers: int = 0
    total_chunks: int = 0
    total_entities: int = 0
    total_relations: int = 0
    total_notes: int = 0
    total_tokens_used: int = 0
    storage_size_bytes: int = 0


@dataclass
class PaperIngestionResult:
    """论文摄入结果"""
    paper_id: str
    success: bool
    chunks_created: int = 0
    entities_extracted: int = 0
    relations_created: int = 0
    error: str = ""
    duration_seconds: float = 0.0
