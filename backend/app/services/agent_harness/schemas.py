"""Agent Harness 输入输出结构"""
from typing import Any

from pydantic import BaseModel, Field


class PaperQASource(BaseModel):
    paper_id: str
    paper_title: str
    page: int
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
