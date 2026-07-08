"""论文检索服务模块"""
from app.services.search.service import SearchService, search_service
from app.services.search.types import SearchResult, SearchQuery

__all__ = [
    "SearchService",
    "search_service",
    "SearchResult",
    "SearchQuery",
]
