"""引用校验工具"""
from app.services.agent_harness.tools.base import BaseTool


class CitationVerifyTool(BaseTool):
    name = "citation.verify"

    async def run(self, tool_input: dict, ctx) -> dict:
        sources = tool_input.get("sources", [])
        valid_sources = [
            source
            for source in sources
            if source.get("paper_id") and source.get("chunk_text") and source.get("page") is not None
        ]
        return {"sources": valid_sources}
