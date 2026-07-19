"""Agent Harness Run API"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.agent_harness import agent_run_service
from app.services.agent_harness.registry import HarnessRegistry
from app.services.agent_harness.schemas import CreateAgentRunRequest
from app.services.agent_harness.schemas import RetrievalDebugRequest
from app.services.agent_harness.schemas import RetrievalDebugResponse

router = APIRouter(prefix="/api/agent-runs", tags=["Agent Runs"])


@router.post("")
async def create_agent_run(data: CreateAgentRunRequest, db: AsyncSession = Depends(get_db)):
    if data.agent != "paper_qa":
        raise HTTPException(status_code=400, detail="当前仅支持 paper_qa")

    return await agent_run_service.create_run(
        db,
        agent_name=data.agent,
        agent_input=data.input,
        context_data=data.context,
    )


@router.post("/retrieve-debug", response_model=RetrievalDebugResponse)
async def debug_retrieve(data: RetrievalDebugRequest, db: AsyncSession = Depends(get_db)):
    registry = HarnessRegistry(db)
    tool = registry.get_tool("rag.retrieve")
    if not hasattr(tool, "debug_retrieve"):
        raise HTTPException(status_code=500, detail="rag.retrieve does not support debug mode")
    result = await tool.debug_retrieve(
        question=data.question.strip(),
        paper_id=data.paper_id,
        top_k=data.top_k,
    )
    return RetrievalDebugResponse.model_validate(result)


@router.get("/{run_id}")
async def get_agent_run(run_id: str, db: AsyncSession = Depends(get_db)):
    run = await agent_run_service.get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@router.get("/{run_id}/events")
async def get_agent_run_events(run_id: str, db: AsyncSession = Depends(get_db)):
    return {"run_id": run_id, "events": await agent_run_service.list_events(db, run_id)}
