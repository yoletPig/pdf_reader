"""Agent Harness 输入输出结构"""
from typing import Any

from pydantic import BaseModel, Field


class PaperQASource(BaseModel):
    paper_id: str
    paper_title: str
    page: int
    chunk_id: str | None = None
    chunk_text: str
    relevance_score: float


class PaperQAAnswer(BaseModel):
    content: str
    sources: list[PaperQASource] = Field(default_factory=list)
    trace_summary: dict[str, Any] = Field(default_factory=dict)


class CreateAgentRunRequest(BaseModel):
    agent: str = "paper_qa"
    input: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)


class AgentRunResponse(BaseModel):
    run_id: str
    agent: str
    status: str
    answer: PaperQAAnswer


class RetrievalDebugRequest(BaseModel):
    question: str
    paper_id: str | None = None
    top_k: int = Field(default=8, ge=1, le=20)


class RetrievalScoreBreakdown(BaseModel):
    vector_score: float = 0.0
    lexical_score: float = 0.0
    bridge_score: float = 0.0
    section_bonus: float = 0.0
    clue_bonus: float = 0.0
    final_score: float = 0.0


class RetrievalDebugResult(BaseModel):
    paper_id: str
    paper_title: str
    page: int
    chunk_id: str
    section_title: str = ""
    chunk_text: str
    relevance_score: float
    score_breakdown: RetrievalScoreBreakdown


class RetrievalDebugResponse(BaseModel):
    question: str
    paper_id: str | None = None
    top_k: int
    candidate_count: int = 0
    used_fallback: bool = False
    results: list[RetrievalDebugResult] = Field(default_factory=list)
