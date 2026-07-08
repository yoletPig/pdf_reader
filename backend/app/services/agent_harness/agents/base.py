"""Agent Profile 抽象"""
from abc import ABC, abstractmethod

from app.services.agent_harness.context import RunContext


class BaseHarnessAgent(ABC):
    name: str = "base"

    @abstractmethod
    async def run(self, agent_input: dict, ctx: RunContext, runtime: "AgentHarnessRuntime") -> dict:
        ...
