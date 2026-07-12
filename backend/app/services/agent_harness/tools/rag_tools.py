"""基于持久化 chunk 的最小检索工具"""
import json
import re

from pydantic import BaseModel, Field
from rank_bm25 import BM25Okapi
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.paper import Paper
from app.models.paper_chunk import PaperChunk
from app.services.agent_harness.context import RunContext
from app.services.agent_harness.schemas import PaperQASource
from app.services.agent_harness.tools.base import BaseTool
from app.services.agent_harness.tools.base import ToolSpec
from app.services.ingestion import vector_index_service


def _tokenize(text: str) -> list[str]:
    text = (text or "").lower()
    raw_tokens = re.findall(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]+", text)
    tokens: list[str] = []

    for token in raw_tokens:
        if re.fullmatch(r"[\u4e00-\u9fff]+", token):
            tokens.append(token)
            if len(token) > 1:
                tokens.extend(token[idx: idx + 2] for idx in range(len(token) - 1))
            tokens.extend(list(token))
        else:
            tokens.append(token)

    return tokens


def _normalize_scores(scores: list[float]) -> list[float]:
    positive_scores = [score for score in scores if score > 0]
    if not positive_scores:
        return [0.0 for _ in scores]

    max_score = max(positive_scores)
    if max_score <= 0:
        return [0.0 for _ in scores]

    return [round(max(score, 0.0) / max_score, 6) for score in scores]


def _query_section_keywords(question: str) -> set[str]:
    question = (question or "").lower()
    if any(keyword in question for keyword in ("核心贡献", "贡献", "创新点", "创新", "motivation", "contribution")):
        return {"abstract", "introduction", "conclusion", "贡献", "摘要", "结论"}
    if any(keyword in question for keyword in ("方法", "模型", "架构", "算法", "method", "approach", "architecture")):
        return {"method", "approach", "architecture", "model", "方法", "网络", "模型"}
    if any(keyword in question for keyword in ("实验", "结果", "性能", "消融", "experiment", "result", "ablation")):
        return {"experiment", "results", "ablation", "实验", "结果", "评估"}
    if any(keyword in question for keyword in ("数据集", "dataset", "benchmark")):
        return {"dataset", "benchmarks", "数据集"}
    if any(keyword in question for keyword in ("局限", "不足", "limitations", "future work")):
        return {"limitation", "discussion", "future", "conclusion", "局限", "讨论", "结论"}
    return set()


def _section_bonus(section_title: str, question: str, page_number: int) -> float:
    normalized_title = (section_title or "").lower()
    matched_keywords = _query_section_keywords(question)
    if any(keyword in normalized_title for keyword in matched_keywords):
        return 0.12
    if page_number <= 2 and any(keyword in (question or "") for keyword in ("贡献", "摘要", "核心")):
        return 0.06
    return 0.0


def _chunk_clue_bonus(question: str, chunk_text: str, page_number: int) -> float:
    question = (question or "").lower()
    text = (chunk_text or "").lower()

    if any(keyword in question for keyword in ("核心贡献", "贡献", "创新点", "创新", "contribution")):
        clues = ("abstract", "we propose", "our contributions", "contributions include", "in order to overcome")
        score = 0.0
        if any(clue in text for clue in clues):
            score += 0.18
        if "main contributions" in text or "our contributions include" in text or "contributions of this paper" in text:
            score += 0.16
        if page_number == 1:
            score += 0.08
        return score

    if any(keyword in question for keyword in ("方法", "模型", "架构", "算法", "method", "approach")):
        clues = ("method", "architecture", "framework", "module", "head", "block")
        return 0.14 if any(clue in text for clue in clues) else 0.0

    if any(keyword in question for keyword in ("实验", "结果", "性能", "消融", "experiment", "result")):
        clues = ("experiment", "results", "dataset", "ablation", "ap", "macaquepose")
        return 0.14 if any(clue in text for clue in clues) else 0.0

    return 0.0


def _fallback_priority(section_title: str, page_number: int) -> int:
    title = (section_title or "").lower()
    if any(keyword in title for keyword in ("abstract", "summary")):
        return 0
    if "introduction" in title:
        return 1
    if "conclusion" in title:
        return 2
    if page_number <= 2:
        return 3
    return 4


class RetrieveChunksInput(BaseModel):
    question: str
    paper_id: str | None = None
    top_k: int = Field(default=8, ge=1, le=12)


class RetrieveChunksOutput(BaseModel):
    sources: list[PaperQASource] = Field(default_factory=list)


class RetrieveChunksTool(BaseTool):
    spec = ToolSpec(
        name="rag.retrieve",
        description="从持久化 paper_chunks 和向量索引中检索与问题最相关的段落。",
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

        stmt = select(PaperChunk, Paper.title, Paper.abstract, Paper.ai_summary_md)
        stmt = stmt.join(Paper, Paper.id == PaperChunk.paper_id)
        if paper_id:
            stmt = stmt.where(PaperChunk.paper_id == paper_id)

        rows = (await self.db.execute(stmt)).all()
        if not rows:
            return RetrieveChunksOutput()

        query_tokens = _tokenize(question)
        vector_hits = await vector_index_service.query(
            question,
            paper_id=paper_id,
            top_k=max(top_k * 4, 24),
        )
        vector_scores_by_chunk = {item["chunk_id"]: item["score"] for item in vector_hits}
        normalized_vector_scores = _normalize_scores(list(vector_scores_by_chunk.values()))
        vector_scores_by_chunk = {
            chunk_id: normalized_vector_scores[idx]
            for idx, chunk_id in enumerate(vector_scores_by_chunk.keys())
        }

        scored: list[PaperQASource] = []
        fallback_candidates = []
        lexical_corpus_tokens: list[list[str]] = []
        bridge_corpus_tokens: list[list[str]] = []
        section_bonuses: list[float] = []
        clue_bonuses: list[float] = []
        sources: list[PaperQASource] = []

        for chunk, paper_title, paper_abstract, ai_summary_md in rows:
            metadata = {}
            try:
                metadata = json.loads(chunk.metadata_json or "{}")
            except Exception:
                metadata = {}
            section_title = str(metadata.get("section_title", "") or "")

            lexical_text = "\n".join(
                part for part in [
                    paper_title or "",
                    paper_abstract or "",
                    section_title,
                    chunk.text,
                ] if part
            )
            bridge_text = "\n".join(
                part for part in [
                    paper_title or "",
                    ai_summary_md or "",
                    section_title,
                ] if part
            )

            source = PaperQASource(
                paper_id=chunk.paper_id,
                paper_title=paper_title or "Untitled Paper",
                page=chunk.page_number,
                chunk_id=chunk.chunk_id,
                chunk_text=chunk.text[:1500],
                relevance_score=0.0,
            )
            sources.append(source)
            lexical_corpus_tokens.append(_tokenize(lexical_text))
            bridge_corpus_tokens.append(_tokenize(bridge_text))
            section_bonuses.append(_section_bonus(section_title, question, chunk.page_number))
            clue_bonuses.append(_chunk_clue_bonus(question, chunk.text, chunk.page_number))
            fallback_candidates.append(
                (
                    _fallback_priority(section_title, chunk.page_number),
                    chunk.page_number,
                    source,
                )
            )

        lexical_scores = (
            BM25Okapi(lexical_corpus_tokens).get_scores(query_tokens).tolist()
            if query_tokens and any(lexical_corpus_tokens)
            else [0.0 for _ in sources]
        )
        bridge_scores = (
            BM25Okapi(bridge_corpus_tokens).get_scores(query_tokens).tolist()
            if query_tokens and any(bridge_corpus_tokens)
            else [0.0 for _ in sources]
        )

        normalized_lexical_scores = _normalize_scores([float(score) for score in lexical_scores])
        normalized_bridge_scores = _normalize_scores([float(score) for score in bridge_scores])

        for idx, source in enumerate(sources):
            vector_score = vector_scores_by_chunk.get(source.chunk_id or "", 0.0)
            combined_score = (
                vector_score * 0.52
                + normalized_lexical_scores[idx] * 0.23
                + normalized_bridge_scores[idx] * 0.09
                + section_bonuses[idx]
                + clue_bonuses[idx]
            )
            source.relevance_score = round(combined_score, 4)
            if combined_score > 0:
                scored.append(source)

        scored.sort(key=lambda item: (item.relevance_score, -item.page), reverse=True)
        if scored:
            return RetrieveChunksOutput(sources=scored[:top_k])

        if paper_id:
            fallback_candidates.sort(key=lambda item: (item[0], item[1]))
            return RetrieveChunksOutput(sources=[item[2] for item in fallback_candidates[:top_k]])

        return RetrieveChunksOutput()
