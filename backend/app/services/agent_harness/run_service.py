"""Agent Run 应用服务"""
import json
from datetime import datetime

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
            await emit("run_started", {"agent": agent_name})
            registry = HarnessRegistry(db)
            runtime = AgentHarnessRuntime(llm_router=llm_router, registry=registry, emit_event=emit)
            runtime.default_model_name = await self._get_default_model_name(db)

            ctx = RunContext(
                run_id=run.id,
                session_id=run.session_id,
                paper_id=run.paper_id or None,
                current_page=context_data.get("current_page"),
                selected_text=context_data.get("selected_text"),
                metadata=context_data,
            )
            result = await runtime.run(agent_name, agent_input, ctx)

            trace_summary = await self._build_trace_summary(db, run.id)
            answer = PaperQAAnswer(
                content=result["content"],
                sources=result.get("sources", []),
                trace_summary=trace_summary,
            )

            run.status = "completed"
            run.output_json = answer.model_dump_json()
            run.completed_at = datetime.utcnow()
            await db.commit()
            await emit("run_finished", {"status": run.status})
            return AgentRunResponse(run_id=run.id, agent=agent_name, status=run.status, answer=answer)
        except Exception as exc:
            run.status = "failed"
            run.error_message = str(exc)
            run.completed_at = datetime.utcnow()
            await db.commit()
            await emit("run_failed", {"error": str(exc)})
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
        return {
            "event_count": len(events),
            "tool_calls": len([event for event in events if event["type"] == "tool_finished"]),
            "llm_calls": len([event for event in events if event["type"] == "llm_started"]),
        }

    async def _get_default_model_name(self, db: AsyncSession) -> str:
        return settings.LLM_MODEL


agent_run_service = AgentRunService()
