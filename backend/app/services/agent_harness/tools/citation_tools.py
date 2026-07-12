"""引用校验工具"""
from pydantic import BaseModel, Field

from app.services.agent_harness.context import RunContext
from app.services.agent_harness.schemas import PaperQASource
from app.services.agent_harness.tools.base import BaseTool
from app.services.agent_harness.tools.base import ToolSpec


class CitationVerifyInput(BaseModel):
    sources: list[PaperQASource] = Field(default_factory=list)


class CitationVerifyOutput(BaseModel):
    sources: list[PaperQASource] = Field(default_factory=list)


class CitationVerifyTool(BaseTool):
    spec = ToolSpec(
        name="citation.verify",
        description="校验回答引用是否包含最基本的来源字段。",
        input_schema=CitationVerifyInput,
        output_schema=CitationVerifyOutput,
        timeout_seconds=10,
        retryable=False,
    )

    async def run(self, tool_input: CitationVerifyInput, ctx: RunContext) -> CitationVerifyOutput:
        sources = tool_input.sources
        valid_sources = [
            source
            for source in sources
            if source.paper_id and source.chunk_text and source.page is not None
        ]
        return CitationVerifyOutput(sources=valid_sources)
