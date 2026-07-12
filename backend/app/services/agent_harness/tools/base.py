"""Tool 抽象"""
from abc import ABC, abstractmethod

from pydantic import BaseModel, ConfigDict

from app.services.agent_harness.context import RunContext


class ToolSpec(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    name: str
    description: str
    input_schema: type[BaseModel]
    output_schema: type[BaseModel]
    timeout_seconds: int = 30
    retryable: bool = True


class BaseTool(ABC):
    spec: ToolSpec

    @property
    def name(self) -> str:
        return self.spec.name

    @abstractmethod
    async def run(self, tool_input: BaseModel, ctx: RunContext) -> BaseModel:
        ...
