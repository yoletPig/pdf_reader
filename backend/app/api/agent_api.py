"""Agent 执行 API"""
from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse
from app.services.agent import agent_orchestrator
from app.services.intent import IntentEngine, SessionContext

router = APIRouter(prefix="/api/agent", tags=["Agent"])
intent_engine = IntentEngine()


@router.post("/execute")
async def execute_agent(data: dict):
    """执行 Agent 任务"""
    user_input = data.get("input", "")
    selected_text = data.get("selected_text")
    paper_id = data.get("paper_id")

    context = SessionContext(current_paper_id=paper_id)
    intent_result = await intent_engine.recognize(
        user_input=user_input,
        context=context,
        selected_text=selected_text,
        current_paper_id=paper_id,
    )

    # 将用户输入合并到参数中
    intent_result.params["user_input"] = user_input

    response = await agent_orchestrator.dispatch(intent_result)
    return {
        "content": response.content,
        "agent_name": response.agent_name,
        "sources": response.sources,
    }


@router.get("/stream")
async def stream_agent_execute(
    input: str = "",
    selected_text: str = "",
    paper_id: str = "",
):
    """SSE 流式 Agent 执行"""
    context = SessionContext(current_paper_id=paper_id)
    intent_result = await intent_engine.recognize(
        user_input=input,
        context=context,
        selected_text=selected_text,
        current_paper_id=paper_id,
    )
    intent_result.params["user_input"] = input

    async def event_generator():
        async for chunk in agent_orchestrator.dispatch_stream(intent_result):
            yield {"data": chunk}

    return EventSourceResponse(event_generator())
