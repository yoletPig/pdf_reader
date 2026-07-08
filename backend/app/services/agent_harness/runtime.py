"""Agent Harness 运行时"""
from app.services.agent_harness.context import RunContext
from app.services.agent_harness.registry import HarnessRegistry


class AgentHarnessRuntime:
    def __init__(self, llm_router, registry: HarnessRegistry, emit_event):
        self.llm_router = llm_router
        self.registry = registry
        self._emit_event = emit_event
        self.default_model_name = ""

    async def emit(self, event_type: str, payload: dict):
        await self._emit_event(event_type, payload)

    async def run(self, agent_name: str, agent_input: dict, ctx: RunContext) -> dict:
        agent = self.registry.get_agent(agent_name)
        return await agent.run(agent_input, ctx, self)
