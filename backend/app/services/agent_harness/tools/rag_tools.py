"""基于持久化 chunk 的最小检索工具"""
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.paper import Paper
from app.models.paper_chunk import PaperChunk
from app.services.agent_harness.tools.base import BaseTool


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]", text.lower())


class RetrieveChunksTool(BaseTool):
    name = "rag.retrieve"

    def __init__(self, db: AsyncSession):
        self.db = db

    async def run(self, tool_input: dict, ctx) -> dict:
        question = tool_input.get("question", "")
        paper_id = tool_input.get("paper_id") or ctx.paper_id
        top_k = max(1, min(int(tool_input.get("top_k", 8)), 12))

        stmt = select(PaperChunk, Paper.title)
        stmt = stmt.join(Paper, Paper.id == PaperChunk.paper_id)
        if paper_id:
            stmt = stmt.where(PaperChunk.paper_id == paper_id)

        rows = (await self.db.execute(stmt)).all()
        if not rows:
            return {"sources": []}

        query_tokens = _tokenize(question)
        scored = []
        for chunk, paper_title in rows:
            chunk_tokens = _tokenize(chunk.text)
            overlap = sum(1 for token in query_tokens if token in chunk_tokens)
            if overlap == 0:
                continue
            score = overlap / max(len(set(query_tokens)), 1)
            scored.append(
                {
                    "paper_id": chunk.paper_id,
                    "paper_title": paper_title or "Untitled Paper",
                    "page": chunk.page_number,
                    "chunk_id": chunk.chunk_id,
                    "chunk_text": chunk.text[:1500],
                    "relevance_score": round(score, 4),
                }
            )

        scored.sort(key=lambda item: item["relevance_score"], reverse=True)
        return {"sources": scored[:top_k]}
