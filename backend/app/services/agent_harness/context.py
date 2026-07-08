"""Run 上下文"""
from pydantic import BaseModel, Field


class RunContext(BaseModel):
    run_id: str
    session_id: str = "default"
    paper_id: str | None = None
    current_page: int | None = None
    selected_text: str | None = None
    metadata: dict = Field(default_factory=dict)
