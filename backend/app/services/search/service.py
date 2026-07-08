"""论文检索服务入口 - 多源聚合检索"""
import asyncio
from app.services.search.types import SearchQuery, SearchResult
from app.services.search.providers.arxiv import ArxivProvider
from app.services.search.providers.semantic_scholar import SemanticScholarProvider
from app.services.search.providers.crossref import CrossrefProvider


class SearchService:
    """多源聚合检索服务"""

    def __init__(self):
        self._providers = {
            "arxiv": ArxivProvider(),
            "semantic_scholar": SemanticScholarProvider(),
            "crossref": CrossrefProvider(),
        }

    async def search(self, query: SearchQuery) -> list[SearchResult]:
        """多源聚合检索"""
        if query.source and query.source in self._providers:
            # 指定单一数据源
            provider = self._providers[query.source]
            return await provider.search(query)
        else:
            # 聚合所有数据源
            tasks = [
                provider.search(query)
                for provider in self._providers.values()
            ]
            results_list = await asyncio.gather(*tasks, return_exceptions=True)

            all_results = []
            for results in results_list:
                if isinstance(results, list):
                    all_results.extend(results)

            # 按引用次数排序
            all_results.sort(key=lambda r: r.citation_count, reverse=True)
            return all_results[:query.max_results]

    async def get_by_id(self, source: str, source_id: str) -> SearchResult | None:
        """根据来源和 ID 获取论文详情"""
        provider = self._providers.get(source)
        if provider:
            return await provider.get_by_id(source_id)
        return None

    async def search_all(
        self,
        query: str,
        max_results: int = 20,
    ) -> dict[str, list[SearchResult]]:
        """在所有数据源中分别搜索"""
        search_query = SearchQuery(query=query, max_results=max_results)
        tasks = {
            name: provider.search(search_query)
            for name, provider in self._providers.items()
        }

        results = {}
        for name, task in tasks.items():
            try:
                results[name] = await task
            except Exception as e:
                results[name] = []

        return results


# 全局单例
search_service = SearchService()
