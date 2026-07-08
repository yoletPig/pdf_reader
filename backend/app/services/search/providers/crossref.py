"""CrossRef API 检索 Provider"""
import httpx
from app.services.search.types import SearchQuery, SearchResult
from app.services.search.providers.base import BaseSearchProvider


class CrossrefProvider(BaseSearchProvider):
    name = "crossref"

    BASE_URL = "https://api.crossref.org/works"

    async def search(self, query: SearchQuery) -> list[SearchResult]:
        """搜索 CrossRef"""
        params = {
            "query": query.query,
            "rows": min(query.max_results, 50),
        }

        if query.year_from:
            params["filter"] = f"from-pub-date:{query.year_from}"
            if query.year_to:
                params["filter"] += f",until-pub-date:{query.year_to}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(self.BASE_URL, params=params)
            resp.raise_for_status()
            data = resp.json()

        return self._parse_results(data.get("message", {}).get("items", []))

    async def get_by_id(self, source_id: str) -> SearchResult | None:
        """根据 DOI 获取详情"""
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{self.BASE_URL}/{source_id}")
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data = resp.json()

        return self._parse_single(data.get("message", {}))

    def _parse_results(self, items: list[dict]) -> list[SearchResult]:
        return [self._parse_single(item) for item in items]

    def _parse_single(self, item: dict) -> SearchResult:
        authors = []
        for author in item.get("author", []):
            given = author.get("given", "")
            family = author.get("family", "")
            authors.append(f"{given} {family}".strip())

        published = item.get("published-print", {}) or item.get("created", {})
        date_parts = published.get("date-parts", [[0]])
        year = date_parts[0][0] if date_parts and date_parts[0] else 0

        return SearchResult(
            title=item.get("title", [""])[0] if item.get("title") else "",
            authors=authors,
            year=year,
            source="crossref",
            source_id=item.get("DOI", ""),
            abstract=item.get("abstract", ""),
            citation_count=item.get("is-referenced-by-count", 0),
            doi=item.get("DOI", ""),
            journal=item.get("container-title", [""])[0] if item.get("container-title") else "",
        )
