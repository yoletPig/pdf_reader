"""Tool 抽象"""
from abc import ABC, abstractmethod

from app.services.agent_harness.context import RunContext


class BaseTool(ABC):
    name: str = "base"

    @abstractmethod
    async def run(self, tool_input: dict, ctx: RunContext) -> dict:
        ...
