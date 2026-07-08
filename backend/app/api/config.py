"""单模型配置 API"""
import time

from fastapi import APIRouter

from app.config import settings
from app.services.llm.adapters.openai_adapter import OpenAIAdapter
from app.services.llm.types import LLMConfig, LLMMessage, LLMRequest

router = APIRouter(prefix="/api/config", tags=["模型配置"])


def _masked_api_key() -> str:
    key = settings.LLM_API_KEY or ""
    if len(key) > 12:
        return key[:8] + "..." + key[-4:]
    if key:
        return "***"
    return ""


def _current_model_config() -> dict:
    return {
        "configured": settings.is_llm_configured(),
        "base_url": settings.LLM_BASE_URL,
        "api_key": _masked_api_key(),
        "model": settings.LLM_MODEL,
        "max_tokens": settings.LLM_MAX_TOKENS,
        "temperature": settings.LLM_TEMPERATURE,
        "trust_env": settings.LLM_TRUST_ENV,
    }


@router.get("/model")
async def get_model_config():
    return _current_model_config()


@router.post("/test")
async def test_model():
    llm_cfg = LLMConfig(
        api_key=settings.LLM_API_KEY,
        base_url=settings.LLM_BASE_URL,
        model=settings.LLM_MODEL,
        max_tokens=settings.LLM_MAX_TOKENS,
        temperature=settings.LLM_TEMPERATURE,
        trust_env=settings.LLM_TRUST_ENV,
    )
    adapter = OpenAIAdapter(llm_cfg)
    try:
        start = time.time()
        response = await adapter.chat(
            LLMRequest(
                messages=[LLMMessage(role="user", content="Reply with OK.")],
                max_tokens=16,
                temperature=0.0,
            )
        )
        latency_ms = round((time.time() - start) * 1000)
        return {
            "status": "ok",
            "latency_ms": latency_ms,
            "response": response.content[:100],
            "model": response.model or settings.LLM_MODEL,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "model": settings.LLM_MODEL}
    finally:
        await adapter.close()
