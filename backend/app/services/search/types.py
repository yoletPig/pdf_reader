"""检索相关类型"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SearchQuery:
    """检索查询"""
    query: str
    source: Optional[str] = None  # arxiv / semantic_scholar / crossref
    year_from: Optional[int] = None
    year_to: Optional[int] = None
    max_results: int = 20


@dataclass
class SearchResult:
    """检索结果"""
    title: str
    authors: list[str] = field(default_factory=list)
    year: int = 0
    source: str = ""
    source_id: str = ""
    abstract: str = ""
    citation_count: int = 0
    pdf_url: str = ""
    doi: str = ""
    journal: str = ""
    categories: list[str] = field(default_factory=list)
