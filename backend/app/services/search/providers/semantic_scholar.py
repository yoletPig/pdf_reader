"""Semantic Scholar API 检索 Provider"""
import httpx
from app.services.search.types import SearchQuery, SearchResult
from app.services.search.providers.base import BaseSearchProvider


class SemanticScholarProvider(BaseSearchProvider):
    name = "semantic_scholar"

    BASE_URL = "https://api.semanticscholar.org/graph/v1"

    async def search(self, query: SearchQuery) -> list[SearchResult]:
        """搜索 Semantic Scholar"""
        params = {
            "query": query.query,
            "limit": min(query.max_results, 50),
            "fields": "title,authors,year,abstract,externalIds,citationCount,journal,url",
        }

        if query.year_from:
            params["year"] = f"{query.year_from}-{query.year_to or ''}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{self.BASE_URL}/paper/search", params=params)
            resp.raise_for_status()
            data = resp.json()

        return self._parse_results(data.get("data", []))

    async def get_by_id(self, source_id: str) -> SearchResult | None:
        """根据 Semantic Scholar ID 获取详情"""
        fields = "title,authors,year,abstract,externalIds,citationCount,journal,url"

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self.BASE_URL}/paper/{source_id}",
                params={"fields": fields},
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data = resp.json()

        return self._parse_single(data)

    def _parse_results(self, papers: list[dict]) -> list[SearchResult]:
        """解析结果列表"""
        return [self._parse_single(p) for p in papers]

    def _parse_single(self, paper: dict) -> SearchResult:
        """解析单条结果"""
        authors = [a.get("name", "") for a in paper.get("authors", [])]
        external_ids = paper.get("externalIds", {})

        return SearchResult(
            title=paper.get("title", ""),
            authors=authors,
            year=paper.get("year", 0),
            source="semantic_scholar",
            source_id=paper.get("paperId", ""),
            abstract=paper.get("abstract", ""),
            citation_count=paper.get("citationCount", 0),
            pdf_url=paper.get("url", ""),
            doi=external_ids.get("DOI", ""),
            journal=paper.get("journal", {}).get("name", "") if paper.get("journal") else "",
        )
