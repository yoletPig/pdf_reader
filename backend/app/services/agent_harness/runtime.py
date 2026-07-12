"""Agent Harness 运行时"""
import asyncio
from time import perf_counter

from pydantic import BaseModel

from app.services.agent_harness.context import RunContext
from app.services.agent_harness.registry import HarnessRegistry


class AgentHarnessRuntime:
    def __init__(self, llm_router, registry: HarnessRegistry, emit_event):
        self.llm_router = llm_router
        self.registry = registry
        self._emit_event = emit_event
        self.default_model_name = ""
        self._active_agent = None

    async def emit(self, event_type: str, payload: dict):
        await self._emit_event(event_type, payload)

    async def call_tool(self, tool_name: str, tool_input: dict, ctx: RunContext) -> BaseModel:
        if self._active_agent and tool_name not in self._active_agent.profile.allowed_tools:
            raise ValueError(f"tool not allowed for agent {self._active_agent.name}: {tool_name}")

        tool = self.registry.get_tool(tool_name)
        validated_input = tool.spec.input_schema.model_validate(tool_input)
        max_attempts = 2 if tool.spec.retryable else 1
        last_error: Exception | None = None

        for attempt in range(1, max_attempts + 1):
            await self.emit(
                "tool_started",
                {
                    "tool": tool_name,
                    "attempt": attempt,
                    "timeout_seconds": tool.spec.timeout_seconds,
                },
            )
            started_at = perf_counter()
            try:
                result = await asyncio.wait_for(
                    tool.run(validated_input, ctx),
                    timeout=tool.spec.timeout_seconds,
                )
                validated_output = tool.spec.output_schema.model_validate(self._serialize(result))
                await self.emit(
                    "tool_finished",
                    {
                        "tool": tool_name,
                        "attempt": attempt,
                        "duration_ms": self._elapsed_ms(started_at),
                        "summary": self._summarize_payload(validated_output.model_dump()),
                    },
                )
                return validated_output
            except Exception as exc:
                last_error = exc
                await self.emit(
                    "tool_failed",
                    {
                        "tool": tool_name,
                        "attempt": attempt,
                        "duration_ms": self._elapsed_ms(started_at),
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    },
                )
                if attempt < max_attempts:
                    await self.emit(
                        "retry_scheduled",
                        {
                            "tool": tool_name,
                            "attempt": attempt,
                            "next_attempt": attempt + 1,
                        },
                    )

        assert last_error is not None
        raise last_error

    async def call_llm(self, request, *, model: str = ""):
        requested_model = model or request.model or self.default_model_name
        await self.emit(
            "llm_started",
            {
                "model": requested_model,
                "message_count": len(request.messages),
                "max_tokens": request.max_tokens,
            },
        )
        started_at = perf_counter()
        response = await self.llm_router.chat(request, model=model)
        await self.emit(
            "llm_finished",
            {
                "model": response.model or requested_model,
                "duration_ms": self._elapsed_ms(started_at),
                "usage": response.usage,
                "finish_reason": response.finish_reason,
            },
        )
        return response

    async def run(self, agent_name: str, agent_input: dict, ctx: RunContext) -> dict:
        agent = self.registry.get_agent(agent_name)
        self._active_agent = agent
        try:
            return await agent.run(agent_input, ctx, self)
        finally:
            self._active_agent = None

    def _elapsed_ms(self, started_at: float) -> int:
        return int((perf_counter() - started_at) * 1000)

    def _serialize(self, value):
        if isinstance(value, BaseModel):
            return value.model_dump()
        return value

    def _summarize_payload(self, payload: dict) -> dict:
        summary = {"keys": list(payload.keys())}
        if isinstance(payload.get("sources"), list):
            summary["source_count"] = len(payload["sources"])
        if isinstance(payload.get("content"), str):
            summary["content_length"] = len(payload["content"])
        return summary
