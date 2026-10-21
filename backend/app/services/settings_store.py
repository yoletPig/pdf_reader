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
            {
                "key": "llm.trust_env",
                "label": "信任系统代理环境变量",
                "type": "boolean",
                "description": "服务器需代理访问模型地址时开启（自动读取 http_proxy/https_proxy）",
                "default": True,
            },
            {
                "key": "llm.reasoning_effort",
                "label": "思考程度",
                "type": "enum",
                "choices": [
                    {"value": "default", "label": "默认（跟随模型）"},
                    {"value": "none", "label": "关闭思考（最快）"},
                    {"value": "low", "label": "低"},
                    {"value": "medium", "label": "中"},
                    {"value": "high", "label": "高"},
                    {"value": "xhigh", "label": "超高（最深）"},
                ],
                "default": "default",
                "description": "推理模型的思考深度：关闭可显著加快翻译/对话响应，加深可提升复杂内容质量。仅对支持 reasoning_effort 参数的端点生效",
            },
        ],
    },
    "agent": {
        "title": "Agent 设置",
        "description": "论文问答 Agent 的行为：自定义指令、技能（Skills）、MCP 工具服务器",
        "fields": [
            {
                "key": "agent.system_prompt",
                "label": "自定义系统指令",
                "type": "text",
                "default": "",
                "description": "追加到内置系统提示之后的自定义指令（如回答风格、语言、引用格式要求）。留空表示仅使用内置提示",
            },
            {
                "key": "agent.max_turns",
                "label": "最大工具调用轮数",
                "type": "number",
                "default": 25,
                "description": "单次问答中 agent 自主调用工具的最大轮数（防止死循环消耗 token），范围 1-200",
            },
            {
                "key": "agent.context_window",
                "label": "模型上下文窗口",
                "type": "number",
                "default": 128000,
                "description": "模型上下文窗口大小（tokens），用于对话页上下文用量条估算，范围 1000-2000000",
            },
            {
                "key": "agent.skills",
                "label": "技能（Skills）",
                "type": "list",
                "item": "skill",
                "default": [],
                "description": "可复用的提示词/知识片段。agent 遇到相关任务时可通过 use_skill 工具加载技能全文",
            },
            {
                "key": "agent.mcp_servers",
                "label": "MCP 服务器",
                "type": "list",
                "item": "mcp",
                "default": [],
                "description": "Model Context Protocol 工具服务器（stdio 本地进程或 HTTP 远程）。连接成功后其工具自动注册给 agent 调用",
            },
        ],
    },
}


# ---------------------------------------------------------------------------
# agent.* 结构化设置项校验
# ---------------------------------------------------------------------------


def _as_structured(value: Any, expect: type) -> Any:
    """兼容旧数据：JSON 字符串自动解析为结构化值。"""
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return [] if expect is list else {}
        try:
            value = json.loads(text)
        except Exception:
            raise ValueError("不是合法的 JSON")
    if not isinstance(value, expect):
        raise ValueError(f"需要 {expect.__name__} 类型")
    return value


def validate_setting_value(key: str, value: Any) -> Any:
    """校验并规范化设置值（返回规范化后的值；非法时抛 ValueError）。"""
    if value is None or (isinstance(value, str) and value == ""):
        return None
    if key == "agent.max_turns":
        n = int(value)
        if not 1 <= n <= 200:
            raise ValueError("最大工具调用轮数需在 1-200 之间")
        return n
    if key == "agent.context_window":
        n = int(value)
        if not 1000 <= n <= 2_000_000:
            raise ValueError("上下文窗口需在 1000-2000000 之间")
        return n
    if key == "agent.system_prompt":
        return str(value)
    if key == "agent.skills":
        items = _as_structured(value, list)
        names = set()
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"第 {i + 1} 个技能必须是对象")
            name = str(item.get("name") or "").strip()
            if not name:
                raise ValueError(f"第 {i + 1} 个技能缺少 name")
            if name in names:
                raise ValueError(f"技能名重复: {name}")
            names.add(name)
            if not str(item.get("content") or "").strip():
                raise ValueError(f"技能 {name} 缺少 content")
        return [
            {
                "name": str(item["name"]).strip(),
                "description": str(item.get("description") or "").strip(),
                "content": str(item.get("content") or ""),
            }
            for item in items
        ]
    if key == "agent.mcp_servers":
        items = _as_structured(value, list)
        names = set()
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"第 {i + 1} 个 MCP 服务器必须是对象")
            name = str(item.get("name") or "").strip()
            if not name:
                raise ValueError(f"第 {i + 1} 个 MCP 服务器缺少 name")
            if name in names:
                raise ValueError(f"MCP 服务器名重复: {name}")
            names.add(name)
            transport = str(item.get("transport") or "stdio")
            if transport not in ("stdio", "http"):
                raise ValueError(f"MCP 服务器 {name} 的 transport 仅支持 stdio/http")
            if transport == "stdio" and not str(item.get("command") or "").strip():
                raise ValueError(f"MCP 服务器 {name} 缺少 command")
            if transport == "http" and not str(item.get("url") or "").strip():
                raise ValueError(f"MCP 服务器 {name} 缺少 url")
        return [
            {
                "name": str(item.get("name") or "").strip(),
                "transport": str(item.get("transport") or "stdio"),
                "command": str(item.get("command") or ""),
                "args": [str(a) for a in (item.get("args") or []) if str(a).strip()],
                "env": {str(k): str(v) for k, v in (item.get("env") or {}).items()}
                if isinstance(item.get("env"), dict)
                else {},
                "url": str(item.get("url") or ""),
                "headers": {str(k): str(v) for k, v in (item.get("headers") or {}).items()}
                if isinstance(item.get("headers"), dict)
                else {},
                "enabled": bool(item.get("enabled", True)),
            }
            for item in items
        ]
    return value


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
    if key == "llm.reasoning_effort":
        return settings.LLM_REASONING_EFFORT
    if key == "llm.trust_env":
        return settings.LLM_TRUST_ENV
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
