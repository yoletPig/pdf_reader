"""基于持久化 chunk 的最小检索工具"""
import re

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.paper import Paper
from app.models.paper_chunk import PaperChunk
from app.services.agent_harness.context import RunContext
from app.services.agent_harness.schemas import PaperQASource
from app.services.agent_harness.tools.base import BaseTool
from app.services.agent_harness.tools.base import ToolSpec


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]", text.lower())


class RetrieveChunksInput(BaseModel):
    question: str
    paper_id: str | None = None
    top_k: int = Field(default=8, ge=1, le=12)


class RetrieveChunksOutput(BaseModel):
    sources: list[PaperQASource] = Field(default_factory=list)


class RetrieveChunksTool(BaseTool):
    spec = ToolSpec(
        name="rag.retrieve",
        description="从持久化 paper_chunks 中检索与问题最相关的段落。",
        input_schema=RetrieveChunksInput,
        output_schema=RetrieveChunksOutput,
        timeout_seconds=15,
        retryable=False,
    )

    def __init__(self, db: AsyncSession):
        self.db = db

    async def run(self, tool_input: RetrieveChunksInput, ctx: RunContext) -> RetrieveChunksOutput:
        question = tool_input.question
        paper_id = tool_input.paper_id or ctx.paper_id
        top_k = tool_input.top_k

        stmt = select(PaperChunk, Paper.title)
        stmt = stmt.join(Paper, Paper.id == PaperChunk.paper_id)
        if paper_id:
            stmt = stmt.where(PaperChunk.paper_id == paper_id)

        rows = (await self.db.execute(stmt)).all()
        if not rows:
            return RetrieveChunksOutput()

        query_tokens = _tokenize(question)
        scored = []
        for chunk, paper_title in rows:
            chunk_tokens = _tokenize(chunk.text)
            overlap = sum(1 for token in query_tokens if token in chunk_tokens)
            if overlap == 0:
                continue
            score = overlap / max(len(set(query_tokens)), 1)
            scored.append(
                PaperQASource(
                    paper_id=chunk.paper_id,
                    paper_title=paper_title or "Untitled Paper",
                    page=chunk.page_number,
                    chunk_id=chunk.chunk_id,
                    chunk_text=chunk.text[:1500],
                    relevance_score=round(score, 4),
                )
            )

        scored.sort(key=lambda item: item.relevance_score, reverse=True)
        return RetrieveChunksOutput(sources=scored[:top_k])
