"""Agent Profile 抽象"""
from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.services.agent_harness.context import RunContext


class AgentProfile(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    name: str
    description: str
    system_prompt_key: str
    allowed_tools: list[str] = Field(default_factory=list)
    output_schema: type[BaseModel]
    max_steps: int = 8
    require_citations: bool = False


class BaseHarnessAgent(ABC):
    profile: AgentProfile

    @property
    def name(self) -> str:
        return self.profile.name

    @abstractmethod
    async def run(self, agent_input: dict, ctx: RunContext, runtime: "AgentHarnessRuntime") -> dict:
        ...
