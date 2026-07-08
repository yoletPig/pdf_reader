"""检索 Provider 基类"""
from abc import ABC, abstractmethod
from app.services.search.types import SearchQuery, SearchResult


class BaseSearchProvider(ABC):
    """检索 Provider 抽象基类"""

    name: str = "base"

    @abstractmethod
    async def search(self, query: SearchQuery) -> list[SearchResult]:
        """执行检索"""
        ...

    @abstractmethod
    async def get_by_id(self, source_id: str) -> SearchResult | None:
        """根据 ID 获取论文详情"""
        ...
