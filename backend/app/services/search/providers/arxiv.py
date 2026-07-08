"""arXiv API 检索 Provider"""
import httpx
import xml.etree.ElementTree as ET
from datetime import datetime
from app.services.search.types import SearchQuery, SearchResult
from app.services.search.providers.base import BaseSearchProvider


class ArxivProvider(BaseSearchProvider):
    name = "arxiv"

    BASE_URL = "https://export.arxiv.org/api/query"

    async def search(self, query: SearchQuery) -> list[SearchResult]:
        """搜索 arXiv"""
        params = {
            "search_query": query.query,
            "start": 0,
            "max_results": min(query.max_results, 50),
            "sortBy": "relevance",
            "sortOrder": "descending",
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(self.BASE_URL, params=params)
            resp.raise_for_status()

        return self._parse_results(resp.text)

    async def get_by_id(self, source_id: str) -> SearchResult | None:
        """根据 arXiv ID 获取详情"""
        params = {
            "id_list": source_id,
            "max_results": 1,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(self.BASE_URL, params=params)
            resp.raise_for_status()

        results = self._parse_results(resp.text)
        return results[0] if results else None

    def _parse_results(self, xml_text: str) -> list[SearchResult]:
        """解析 arXiv XML 响应"""
        ns = {
            "atom": "http://www.w3.org/2005/Atom",
            "arxiv": "http://arxiv.org/schemas/atom",
        }

        root = ET.fromstring(xml_text)
        results = []

        for entry in root.findall("atom:entry", ns):
            title = entry.find("atom:title", ns)
            title_text = title.text.strip().replace("\n", " ") if title is not None else ""

            abstract = entry.find("atom:summary", ns)
            abstract_text = abstract.text.strip().replace("\n", " ") if abstract is not None else ""

            authors = [
                author.find("atom:name", ns).text
                for author in entry.findall("atom:author", ns)
                if author.find("atom:name", ns) is not None
            ]

            # 提取 arXiv ID
            arxiv_id = ""
            id_url = entry.find("atom:id", ns)
            if id_url is not None and id_url.text:
                arxiv_id = id_url.text.split("/abs/")[-1]

            # 提取年份
            published = entry.find("atom:published", ns)
            year = 0
            if published is not None and published.text:
                try:
                    year = datetime.fromisoformat(published.text.replace("Z", "+00:00")).year
                except ValueError:
                    pass

            # 提取分类
            categories = [
                cat.get("term", "")
                for cat in entry.findall("atom:category", ns)
            ]

            # PDF 链接
            pdf_url = ""
            for link in entry.findall("atom:link", ns):
                if link.get("title") == "pdf":
                    pdf_url = link.get("href", "")
                    break

            results.append(SearchResult(
                title=title_text,
                authors=authors,
                year=year,
                source="arxiv",
                source_id=arxiv_id,
                abstract=abstract_text,
                pdf_url=pdf_url,
                categories=categories,
            ))

        return results
