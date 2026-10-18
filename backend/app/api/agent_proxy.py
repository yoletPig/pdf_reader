"""agent-gateway 代理路由 - 将 /api/agent-runs 转发到 Node pi agent 服务"""
import json

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from fastapi import Depends

router = APIRouter(prefix="/api/agent-runs", tags=["Agent (pi)"])

# 不随请求转发的 hop-by-hop 头
_HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"}


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=settings.AGENT_GATEWAY_URL, timeout=httpx.Timeout(600.0, connect=10.0))


async def _invalidate_gateway_config():
    """通知 agent-gateway 重新拉取模型配置（设置保存后调用）。"""
    try:
        async with _client() as client:
            await client.post("/api/agent-runs/invalidate-config")
    except Exception:
        pass  # 网关未启动时静默忽略


async def _forward_json(method: str, path: str, body: dict) -> Response:
    async with _client() as client:
        upstream = await client.request(method, path, json=body)
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )


@router.post("")
async def create_agent_run(request: Request):
    body = await request.json()
    return await _forward_json("POST", "/api/agent-runs", body)


@router.post("/stream")
async def stream_agent_run(request: Request):
    """SSE 流式转发到 agent-gateway。"""
    body = await request.json()

    async def relay():
        async with _client() as client:
            async with client.stream("POST", "/api/agent-runs/stream", json=body) as upstream:
                async for chunk in upstream.aiter_bytes():
                    yield chunk

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/reset")
async def reset_agent_run(request: Request):
    body = await request.json()
    return await _forward_json("POST", "/api/agent-runs/reset", body)


@router.post("/invalidate-config")
async def invalidate_config():
    """模型配置更新后由设置 API 内部调用；也可手动触发。"""
    await _invalidate_gateway_config()
    return {"status": "ok"}


@router.get("/health")
async def agent_gateway_health():
    """透传 agent-gateway 健康状态。"""
    try:
        async with _client() as client:
            upstream = await client.get("/health")
            return upstream.json()
    except Exception as exc:
        return {"status": "unreachable", "detail": str(exc)[:200]}
