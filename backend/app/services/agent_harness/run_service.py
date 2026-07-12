"""Agent Run 应用服务"""
import json
from datetime import datetime
from statistics import mean

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_event import AgentEvent
from app.models.agent_run import AgentRun
from app.config import settings
from app.services.agent_harness.context import RunContext
from app.services.agent_harness.registry import HarnessRegistry
from app.services.agent_harness.runtime import AgentHarnessRuntime
from app.services.agent_harness.schemas import AgentRunResponse, PaperQAAnswer
from app.services.llm import llm_router


class AgentRunService:
    def _duration_ms(self, run: AgentRun) -> int:
        end_time = run.completed_at or datetime.utcnow()
        return max(int((end_time - run.created_at).total_seconds() * 1000), 0)

    async def _load_conversation_history(
        self,
        db: AsyncSession,
        *,
        session_id: str,
        paper_id: str,
        current_run_id: str,
        limit: int = 6,
    ) -> list[dict]:
        stmt = (
            select(AgentRun)
            .where(
                AgentRun.session_id == session_id,
                AgentRun.id != current_run_id,
            )
            .order_by(AgentRun.created_at.desc())
            .limit(limit)
        )
        if paper_id:
            stmt = stmt.where(AgentRun.paper_id == paper_id)

        rows = (await db.execute(stmt)).scalars().all()
        history: list[dict] = []

        for row in reversed(rows):
            try:
                agent_input = json.loads(row.input_json or "{}")
            except Exception:
                agent_input = {}
            try:
                output = json.loads(row.output_json or "{}")
            except Exception:
                output = {}

            question = (agent_input.get("question") or "").strip()
            answer = (output.get("content") or "").strip()
            if question:
                history.append({"role": "user", "content": question})
            if answer:
                history.append({"role": "assistant", "content": answer})

        return history

    async def create_run(
        self,
        db: AsyncSession,
        *,
        agent_name: str,
        agent_input: dict,
        context_data: dict,
    ) -> AgentRunResponse:
        run = AgentRun(
            agent_name=agent_name,
            status="running",
            session_id=context_data.get("session_id", "default"),
            paper_id=context_data.get("paper_id") or agent_input.get("paper_id") or "",
            input_json=json.dumps(agent_input, ensure_ascii=False),
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)

        async def emit(event_type: str, payload: dict):
            sequence_stmt = select(AgentEvent).where(AgentEvent.run_id == run.id)
            sequence = len((await db.execute(sequence_stmt)).scalars().all()) + 1
            db.add(
                AgentEvent(
                    run_id=run.id,
                    sequence=sequence,
                    event_type=event_type,
                    payload_json=json.dumps(payload, ensure_ascii=False),
                )
            )
            await db.commit()

        try:
            await emit("run_started", {"agent": agent_name, "session_id": run.session_id})
            registry = HarnessRegistry(db)
            runtime = AgentHarnessRuntime(llm_router=llm_router, registry=registry, emit_event=emit)
            runtime.default_model_name = await self._get_default_model_name(db)

            ctx = RunContext(
                run_id=run.id,
                session_id=run.session_id,
                paper_id=run.paper_id or None,
                current_page=context_data.get("current_page"),
                selected_text=context_data.get("selected_text"),
                metadata={
                    **context_data,
                    "conversation_history": await self._load_conversation_history(
                        db,
                        session_id=run.session_id,
                        paper_id=run.paper_id,
                        current_run_id=run.id,
                    ),
                },
            )
            result = await runtime.run(agent_name, agent_input, ctx)

            run.status = "completed"
            run.completed_at = datetime.utcnow()
            run.duration_ms = self._duration_ms(run)
            await db.commit()
            await emit("run_finished", {"status": run.status, "duration_ms": run.duration_ms})

            trace_summary = await self._build_trace_summary(db, run.id)
            answer = PaperQAAnswer(
                content=result["content"],
                sources=result.get("sources", []),
                trace_summary=trace_summary,
            )
            run.output_json = answer.model_dump_json()
            await db.commit()
            return AgentRunResponse(run_id=run.id, agent=agent_name, status=run.status, answer=answer)
        except Exception as exc:
            run.status = "failed"
            run.error_message = str(exc)
            run.error_type = type(exc).__name__
            run.completed_at = datetime.utcnow()
            run.duration_ms = self._duration_ms(run)
            await db.commit()
            await emit(
                "run_failed",
                {
                    "error": str(exc),
                    "error_type": type(exc).__name__,
                    "duration_ms": run.duration_ms,
                },
            )
            raise

    async def get_run(self, db: AsyncSession, run_id: str) -> AgentRunResponse | None:
        run = (
            await db.execute(select(AgentRun).where(AgentRun.id == run_id))
        ).scalar_one_or_none()
        if not run:
            return None

        output = json.loads(run.output_json or "{}")
        answer = PaperQAAnswer(
            content=output.get("content", ""),
            sources=output.get("sources", []),
            trace_summary=output.get("trace_summary", await self._build_trace_summary(db, run.id)),
        )
        return AgentRunResponse(run_id=run.id, agent=run.agent_name, status=run.status, answer=answer)

    async def list_events(self, db: AsyncSession, run_id: str) -> list[dict]:
        rows = (
            await db.execute(
                select(AgentEvent).where(AgentEvent.run_id == run_id).order_by(AgentEvent.sequence.asc())
            )
        ).scalars().all()
        return [
            {
                "sequence": row.sequence,
                "type": row.event_type,
                "payload": json.loads(row.payload_json or "{}"),
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]

    async def _build_trace_summary(self, db: AsyncSession, run_id: str) -> dict:
        events = await self.list_events(db, run_id)
        run = (
            await db.execute(select(AgentRun).where(AgentRun.id == run_id))
        ).scalar_one_or_none()
        tool_finished_events = [event for event in events if event["type"] == "tool_finished"]
        tool_failed_events = [event for event in events if event["type"] == "tool_failed"]
        llm_finished_events = [event for event in events if event["type"] == "llm_finished"]
        tool_latency_by_name: dict[str, list[int]] = {}
        for event in tool_finished_events:
            payload = event["payload"]
            tool_name = payload.get("tool", "unknown")
            tool_latency_by_name.setdefault(tool_name, []).append(int(payload.get("duration_ms", 0)))

        token_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        for event in llm_finished_events:
            usage = event["payload"].get("usage") or {}
            token_usage["prompt_tokens"] += int(usage.get("prompt_tokens", 0) or 0)
            token_usage["completion_tokens"] += int(usage.get("completion_tokens", 0) or 0)
            token_usage["total_tokens"] += int(usage.get("total_tokens", 0) or 0)

        citation_events = [event for event in events if event["type"] == "citation_checked"]
        citation_payload = citation_events[-1]["payload"] if citation_events else {}
        citation_total = int(citation_payload.get("total", 0) or 0)
        citation_valid = int(citation_payload.get("valid", 0) or 0)

        return {
            "event_count": len(events),
            "tool_calls": len(tool_finished_events),
            "tool_failures": len(tool_failed_events),
            "llm_calls": len(llm_finished_events),
            "duration_ms": run.duration_ms if run else 0,
            "token_usage": token_usage,
            "tool_latency_ms": {
                tool_name: {
                    "count": len(latencies),
                    "avg": int(mean(latencies)),
                    "max": max(latencies),
                }
                for tool_name, latencies in tool_latency_by_name.items()
            },
            "error_types": sorted(
                {
                    event["payload"].get("error_type")
                    for event in events
                    if event["payload"].get("error_type")
                }
            ),
            "citation_pass_rate": round(citation_valid / citation_total, 4) if citation_total else None,
        }

    async def _get_default_model_name(self, db: AsyncSession) -> str:
        return settings.LLM_MODEL


agent_run_service = AgentRunService()
