"""Agent 事件协议"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AgentEventPayload(BaseModel):
    run_id: str
    type: Literal[
        "run_started",
        "tool_started",
        "tool_finished",
        "llm_started",
        "citation_checked",
        "run_finished",
        "run_failed",
    ]
    payload: dict = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.utcnow)
