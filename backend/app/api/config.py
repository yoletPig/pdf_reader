"""系统设置 API - 模型配置 / PDF 识别方式管理"""
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.app_setting import AppSetting
from app.services import settings_store
from app.services.llm.adapters.openai_adapter import OpenAIAdapter
from app.services.llm.types import LLMConfig, LLMMessage, LLMRequest

router = APIRouter(prefix="/api/config", tags=["系统设置"])


async def _load_overrides(db: AsyncSession) -> dict:
    rows = (await db.execute(select(AppSetting))).scalars().all()
    overrides = {}
    for row in rows:
        try:
            overrides[row.key] = json.loads(row.value_json or "null")
        except Exception:
            continue
    return overrides


async def _effective_llm_config(db: AsyncSession) -> LLMConfig:
    """合并 .env 与数据库覆盖后的 LLM 配置。"""
    overrides = await _load_overrides(db)
    return LLMConfig(
        api_key=str(overrides.get("llm.api_key", settings.LLM_API_KEY) or ""),
        base_url=str(overrides.get("llm.base_url", settings.LLM_BASE_URL) or ""),
        model=str(overrides.get("llm.model", settings.LLM_MODEL) or ""),
        max_tokens=int(overrides.get("llm.max_tokens", settings.LLM_MAX_TOKENS) or 4096),
        temperature=float(overrides.get("llm.temperature", settings.LLM_TEMPERATURE) or 0.3),
        trust_env=settings.LLM_TRUST_ENV,
    )


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    """返回全部系统设置（secret 脱敏）。"""
    await settings_store.refresh_pdf_engine_cache(db)
    return await settings_store.get_effective_settings_public(db)


class SaveSettingRequest(BaseModel):
    key: str  # 完整 key，如 "llm.model" / "pdf.pdf_engine"
    value: str | int | float | None


@router.put("/settings")
async def save_setting(data: SaveSettingRequest, db: AsyncSession = Depends(get_db)):
    """保存单个设置项；空值表示清除覆盖回退 .env 默认。"""
    valid_keys = {
        settings_store._setting_key(group_name, field["key"])
        for group_name, group in settings_store.SETTING_GROUPS.items()
        for field in group["fields"]
    }
    if data.key not in valid_keys:
        raise HTTPException(status_code=400, detail=f"未知设置项: {data.key}")

    if data.key == "pdf.pdf_engine":
        engine = str(data.value or "")
        if engine not in settings_store.PDF_ENGINE_CHOICES:
            raise HTTPException(
                status_code=400,
                detail=f"pdf_engine 仅支持: {', '.join(settings_store.PDF_ENGINE_CHOICES)}",
            )

    if data.value is None or (isinstance(data.value, str) and data.value == ""):
        await settings_store.delete_override(db, data.key)
        action = "reset"
    else:
        await settings_store.save_override(db, data.key, data.value)
        action = "saved"

    if data.key == "pdf.pdf_engine":
        engine = await settings_store.refresh_pdf_engine_cache(db)
        return {"status": "ok", "action": action, "pdf_engine": engine}

    if data.key.startswith("llm."):
        cfg = await _effective_llm_config(db)
        from app.services.llm import llm_router
        await llm_router.apply_config(cfg)
        # 通知 agent-gateway 重新拉取模型配置
        try:
            from app.api.agent_proxy import _invalidate_gateway_config
            await _invalidate_gateway_config()
        except Exception:
            pass
        return {"status": "ok", "action": action}

    return {"status": "ok", "action": action}


@router.get("/model")
async def get_model_config(db: AsyncSession = Depends(get_db)):
    overrides = await _load_overrides(db)

    def _effective(key: str, env_value):
        return overrides.get(f"llm.{key}", env_value)

    api_key = str(_effective("api_key", settings.LLM_API_KEY) or "")
    masked = api_key[:8] + "..." + api_key[-4:] if len(api_key) > 12 else ("***" if api_key else "")
    return {
        "configured": bool(
            str(_effective("api_key", settings.LLM_API_KEY)).strip()
            and str(_effective("base_url", settings.LLM_BASE_URL)).strip()
            and str(_effective("model", settings.LLM_MODEL)).strip()
        ),
        "base_url": _effective("base_url", settings.LLM_BASE_URL),
        "api_key": masked,
        "model": _effective("model", settings.LLM_MODEL),
        "max_tokens": _effective("max_tokens", settings.LLM_MAX_TOKENS),
        "temperature": _effective("temperature", settings.LLM_TEMPERATURE),
        "trust_env": settings.LLM_TRUST_ENV,
    }


@router.get("/model-internal")
async def get_model_config_internal(request: Request, db: AsyncSession = Depends(get_db)):
    """返回完整（未脱敏）模型配置。

    仅允许本机访问：供本机运行的 agent-gateway (pi agent) 拉取真实 API Key。
    外部请求一律 403。
    """
    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        raise HTTPException(status_code=403, detail="仅限本机访问")
    overrides = await _load_overrides(db)

    def _effective(key: str, env_value):
        return overrides.get(f"llm.{key}", env_value)

    return {
        "base_url": str(_effective("base_url", settings.LLM_BASE_URL) or ""),
        "api_key": str(_effective("api_key", settings.LLM_API_KEY) or ""),
        "model": str(_effective("model", settings.LLM_MODEL) or ""),
        "max_tokens": int(_effective("max_tokens", settings.LLM_MAX_TOKENS) or 4096),
        "temperature": float(_effective("temperature", settings.LLM_TEMPERATURE) or 0.3),
    }


@router.get("/engines")
async def list_pdf_engines():
    """PDF 引擎可选项与当前引擎。"""
    return {
        "engines": [
            {"value": "pymupdf", "label": "PyMuPDF", "description": "快速轻量，纯文本提取"},
            {"value": "docling", "label": "Docling", "description": "深度解析：公式/表格/结构/图片"},
        ],
        "current": settings_store.current_pdf_engine(),
    }


@router.post("/test")
async def test_model(db: AsyncSession = Depends(get_db)):
    """用当前生效配置测试模型连通性。"""
    cfg = await _effective_llm_config(db)
    if not cfg.api_key or not cfg.base_url:
        raise HTTPException(status_code=400, detail="请先在设置页配置 Base URL 与 API Key")
    adapter = OpenAIAdapter(cfg)
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
            "model": cfg.model,
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "model": cfg.model}
    finally:
        await adapter.close()
