"""RAG 相关类型定义"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class RetrievalMode(str, Enum):
    HYBRID = "hybrid"       # 混合检索
    VECTOR = "vector"       # 仅向量检索
    KEYWORD = "keyword"     # 仅关键词检索
    GRAPH = "graph"         # 仅图谱检索


@dataclass
class Source:
    """引用来源"""
    paper_id: str
    paper_title: str
    page: int
    chunk_text: str
    relevance_score: float
    section_title: str = ""


@dataclass
class RAGResult:
    """RAG 查询结果"""
    answer: str
    sources: list[Source] = field(default_factory=list)
    confidence: float = 0.0
    tokens_used: int = 0


@dataclass
class Chunk:
    """文档分块"""
    id: str
    paper_id: str
    text: str
    section_title: str = ""  # 所属章节标题
    page: int = 0
    chunk_index: int = 0
    heading_level: int = 0
    metadata: dict = field(default_factory=dict)  # 标题层级、图表引用等


@dataclass
class RetrievalItem:
    """检索结果项"""
    chunk: Chunk
    score: float
    source: str = ""  # bm25 / vector / graph
