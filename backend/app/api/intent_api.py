"""意图识别 API"""
from fastapi import APIRouter
from app.services.intent import IntentEngine, SessionContext

router = APIRouter(prefix="/api/intent", tags=["意图识别"])

intent_engine = IntentEngine()


@router.post("/recognize")
async def recognize_intent(data: dict):
    """识别用户意图"""
    user_input = data.get("input", "")
    selected_text = data.get("selected_text")
    paper_id = data.get("paper_id")
    session_id = data.get("session_id", "default")

    context = intent_engine.context_builder.get_or_create(session_id)

    result = await intent_engine.recognize(
        user_input=user_input,
        context=context,
        selected_text=selected_text,
        current_paper_id=paper_id,
    )

    return {
        "intent": result.intent.value,
        "confidence": result.confidence,
        "params": result.params,
        "suggested_agent": result.suggested_agent,
    }
