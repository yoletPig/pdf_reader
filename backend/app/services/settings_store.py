"""系统设置服务 - 合并 .env 默认值与数据库覆盖值"""
import json
import logging
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.app_setting import AppSetting

logger = logging.getLogger(__name__)

# PDF 解析引擎可选项：pymupdf（轻量快速，适合文本型 PDF）/ docling（深度解析，含公式/表格/图片）
PDF_ENGINE_CHOICES = ("pymupdf", "docling")

# 设置项分组定义（供前端设置页渲染）
SETTING_GROUPS = {
    "pdf": {
        "title": "PDF 识别",
        "description": "控制后端解析 PDF 的引擎与行为",
        "fields": [
            {
                "key": "pdf_engine",
                "label": "解析引擎",
                "type": "enum",
                "choices": [
                    {"value": "pymupdf", "label": "PyMuPDF（快速，轻量文本提取）"},
                    {"value": "docling", "label": "Docling（深度解析：公式/表格/结构）"},
                ],
                "default": "pymupdf",
            },
        ],
    },
    "model": {
        "title": "模型配置",
        "description": "OpenAI 兼容的 LLM 服务配置，agent / 翻译 / 总结共用",
        "fields": [
            {"key": "llm.base_url", "label": "Base URL", "type": "string", "default": ""},
            {"key": "llm.api_key", "label": "API Key", "type": "secret", "default": ""},
            {"key": "llm.model", "label": "模型名", "type": "string", "default": ""},
            {"key": "llm.max_tokens", "label": "最大输出 Tokens", "type": "number", "default": 4096},
            {"key": "llm.temperature", "label": "温度", "type": "number", "default": 0.3},
        ],
    },
}


def _setting_key(group: str, field_key: str) -> str:
    """字段 key 已带前缀（如 llm.base_url）则原样返回，否则加组前缀。"""
    if "." in field_key:
        return field_key
    return f"{group}.{field_key}"


def _env_default(key: str) -> Any:
    """读取 .env / Settings 中的默认值（key 为完整设置键）。"""
    if key == "pdf.pdf_engine":
        return settings.PDF_ENGINE
    if key == "llm.base_url":
        return settings.LLM_BASE_URL
    if key == "llm.api_key":
        return settings.LLM_API_KEY
    if key == "llm.model":
        return settings.LLM_MODEL
    if key == "llm.max_tokens":
        return settings.LLM_MAX_TOKENS
    if key == "llm.temperature":
        return settings.LLM_TEMPERATURE
    return None


async def load_overrides(db: AsyncSession) -> dict[str, Any]:
    """读取数据库中的全部覆盖值。"""
    rows = (await db.execute(select(AppSetting))).scalars().all()
    overrides: dict[str, Any] = {}
    for row in rows:
        try:
            overrides[row.key] = json.loads(row.value_json or "null")
        except Exception:
            continue
    return overrides


async def save_override(db: AsyncSession, key: str, value: Any) -> None:
    """写入/更新单个覆盖值。"""
    row = (await db.execute(select(AppSetting).where(AppSetting.key == key))).scalar_one_or_none()
    serialized = json.dumps(value, ensure_ascii=False)
    if row is None:
        row = AppSetting(key=key, value_json=serialized)
        db.add(row)
    else:
        row.value_json = serialized
        from datetime import datetime
        row.updated_at = datetime.utcnow()
    await db.commit()


async def delete_override(db: AsyncSession, key: str) -> None:
    row = (await db.execute(select(AppSetting).where(AppSetting.key == key))).scalar_one_or_none()
    if row is not None:
        await db.delete(row)
        await db.commit()


def resolve_effective(key: str, overrides: dict[str, Any]) -> Any:
    """返回生效值：数据库覆盖值 > .env 默认值 > 分组定义默认值。"""
    if key in overrides:
        return overrides[key]
    env_value = _env_default(key)
    if env_value is not None:
        return env_value
    for group in SETTING_GROUPS.values():
        for field in group["fields"]:
            if field["key"] == key:
                return field["default"]
    return None


async def get_effective_settings(db: AsyncSession) -> dict:
    """返回带元数据的完整设置（供设置页渲染）。"""
    overrides = await load_overrides(db)
    groups = {}
    for group_name, group_def in SETTING_GROUPS.items():
        fields = []
        for field in group_def["fields"]:
            key = _setting_key(group_name, field["key"])
            effective = resolve_effective(key, overrides)
            fields.append({
                **field,
                "key": key,
                "value": effective,
                "overridden": key in overrides,
            })
        groups[group_name] = {**group_def, "fields": fields}
    return {"groups": groups}


def _mask_secret(value: Any) -> Any:
    text = str(value or "")
    if len(text) > 12:
        return text[:8] + "..." + text[-4:]
    return "***" if text else ""


async def get_effective_settings_public(db: AsyncSession) -> dict:
    """设置页展示用：secret 字段脱敏。"""
    data = await get_effective_settings(db)
    for group in data["groups"].values():
        for field in group["fields"]:
            if field.get("type") == "secret":
                field["value"] = _mask_secret(field["value"])
                field["has_value"] = bool(field["value"])
    return data


def current_pdf_engine() -> str:
    """同步获取当前 PDF 引擎（供解析管线调用）。

    引擎切换通常发生在保存设置后，读取轻量缓存即可；
    严格一致性由调用方在需要时传入 db 刷新。
    """
    return _pdf_engine_cache


# 进程内缓存：保存设置时更新，解析管线同步读取
_pdf_engine_cache: str = settings.PDF_ENGINE


def update_pdf_engine_cache(engine: str) -> None:
    global _pdf_engine_cache
    _pdf_engine_cache = engine if engine in PDF_ENGINE_CHOICES else "pymupdf"


async def refresh_pdf_engine_cache(db: AsyncSession) -> str:
    engine = resolve_effective("pdf.pdf_engine", await load_overrides(db))
    engine = engine if engine in PDF_ENGINE_CHOICES else "pymupdf"
    update_pdf_engine_cache(engine)
    return engine
