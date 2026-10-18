"""对话 API - pi agent 会话管理 + 对话历史持久化"""
import json
import logging
import re
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.chat import ChatMessage, ChatSession
from app.models.paper import Paper

router = APIRouter(prefix="/api/chat", tags=["对话"])

logger = logging.getLogger(__name__)

_GATEWAY_TIMEOUT = httpx.Timeout(600.0, connect=10.0)


def _client() -> httpx.AsyncClient:
    # trust_env=False：本机 gateway 调用不经系统代理（避免 HTTP_PROXY 导致 502）
    return httpx.AsyncClient(
        base_url=settings.AGENT_GATEWAY_URL,
        timeout=_GATEWAY_TIMEOUT,
        trust_env=False,
    )


# ---------- 序列化 ----------

def _session_to_dict(session: ChatSession, last_message: str = "", message_count: int = 0) -> dict:
    return {
        "id": session.id,
        "title": session.title,
        "paper_id": session.paper_id or "",
        "created_at": session.created_at.isoformat() if session.created_at else "",
        "updated_at": session.updated_at.isoformat() if session.updated_at else "",
        "last_message": last_message[:120],
        "message_count": message_count,
    }


def _message_to_dict(msg: ChatMessage) -> dict:
    return {
        "id": msg.id,
        "role": msg.role,
        "content": msg.content,
        "sources": json.loads(msg.sources_json or "[]"),
        "meta": json.loads(msg.meta_json or "{}"),
        "created_at": msg.created_at.isoformat() if msg.created_at else "",
    }


async def _load_session_or_404(db: AsyncSession, session_id: str) -> ChatSession:
    session = (await db.execute(select(ChatSession).where(ChatSession.id == session_id))).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="对话不存在")
    return session


# ---------- 会话 CRUD ----------

@router.get("/sessions")
async def list_sessions(db: AsyncSession = Depends(get_db)):
    """会话列表（含最后一条消息预览），最近活跃优先。"""
    sessions = (
        await db.execute(select(ChatSession).order_by(ChatSession.updated_at.desc()))
    ).scalars().all()
    result = []
    for session in sessions:
        last_msg = (
            await db.execute(
                select(ChatMessage)
                .where(ChatMessage.session_id == session.id)
                .order_by(ChatMessage.sequence.desc())
                .limit(1)
            )
        ).scalars().first()
        count = (
            await db.execute(
                select(func.count()).select_from(ChatMessage).where(ChatMessage.session_id == session.id)
            )
        ).scalar() or 0
        result.append(_session_to_dict(session, last_msg.content if last_msg else "", count))
    return {"sessions": result}


class CreateSessionRequest(BaseModel):
    title: str = "新对话"
    paper_id: str = ""


@router.post("/sessions")
async def create_session(data: CreateSessionRequest, db: AsyncSession = Depends(get_db)):
    session = ChatSession(title=data.title.strip() or "新对话", paper_id=data.paper_id.strip())
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return _session_to_dict(session)


class UpdateSessionRequest(BaseModel):
    title: str | None = None
    paper_id: str | None = None


@router.patch("/sessions/{session_id}")
async def update_session(session_id: str, data: UpdateSessionRequest, db: AsyncSession = Depends(get_db)):
    session = await _load_session_or_404(db, session_id)
    if data.title is not None:
        session.title = data.title.strip() or session.title
    if data.paper_id is not None:
        session.paper_id = data.paper_id.strip()
    session.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(session)
    return _session_to_dict(session)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)):
    session = await _load_session_or_404(db, session_id)
    await db.delete(session)
    await db.commit()
    return {"status": "ok", "deleted": session_id}


@router.get("/sessions/{session_id}/messages")
async def list_messages(session_id: str, db: AsyncSession = Depends(get_db)):
    await _load_session_or_404(db, session_id)
    messages = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.sequence.asc())
        )
    ).scalars().all()
    return {"session_id": session_id, "messages": [_message_to_dict(m) for m in messages]}


# ---------- 发送消息（SSE 转发 + 历史持久化） ----------

class SendMessageRequest(BaseModel):
    question: str
    paper_id: str = ""
    selected_text: str = ""
    current_page: int = 0


async def _next_sequence(db: AsyncSession, session_id: str) -> int:
    current = (
        await db.execute(
            select(func.max(ChatMessage.sequence)).where(ChatMessage.session_id == session_id)
        )
    ).scalar()
    return (current or 0) + 1


async def _persist_message(
    db: AsyncSession,
    session_id: str,
    *,
    role: str,
    content: str,
    sources: list | None = None,
    meta: dict | None = None,
) -> ChatMessage:
    seq = await _next_sequence(db, session_id)
    msg = ChatMessage(
        session_id=session_id,
        sequence=seq,
        role=role,
        content=content or "",
        sources_json=json.dumps(sources or [], ensure_ascii=False),
        meta_json=json.dumps(meta or {}, ensure_ascii=False),
    )
    db.add(msg)
    session = (await db.execute(select(ChatSession).where(ChatSession.id == session_id))).scalar_one_or_none()
    if session:
        session.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(msg)
    return msg


async def _build_history(db: AsyncSession, session_id: str, limit: int = 12) -> list[dict]:
    """取最近的历史消息（供 gateway 在会话冷启动时注入上下文）。"""
    rows = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.sequence.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {"role": m.role, "content": m.content[:2000]}
        for m in reversed(rows)
        if m.content.strip()
    ]


def _sse_frame(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _parse_sse_frame(frame: str):
    """解析 gateway SSE 帧 -> (event, data_dict)"""
    event = "message"
    data_lines: list[str] = []
    for line in frame.splitlines():
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if not data_lines:
        return None
    try:
        return event, json.loads("\n".join(data_lines))
    except Exception:
        return None


@router.post("/sessions/{session_id}/stream")
async def send_message_stream(session_id: str, data: SendMessageRequest, request: Request):
    """发送消息：SSE 转发 gateway 输出，并把用户消息与助手回答持久化。"""
    question = data.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="问题不能为空")

    async with async_session_factory() as db:
        session = await _load_session_or_404(db, session_id)
        paper_id = data.paper_id.strip() or (session.paper_id or "")
        history = await _build_history(db, session_id)
        await _persist_message(db, session_id, role="user", content=question)

    payload = {
        "input": {"question": question, "paper_id": paper_id or None},
        "context": {
            "paper_id": paper_id or None,
            "session_id": f"chat-{session_id}",
            "selected_text": data.selected_text or None,
            "current_page": data.current_page or None,
        },
        "history": history,
    }

    async def relay():
        # 持久化用的累积器
        answer_parts: list[str] = []
        sources: list = []
        meta: dict = {}
        first_event = True

        async def persist_assistant(content: str, sources_list: list, meta_dict: dict):
            async with async_session_factory() as db:
                await _persist_message(
                    db,
                    session_id,
                    role="assistant",
                    content=content,
                    sources=sources_list,
                    meta=meta_dict,
                )

        try:
            async with _client() as client:
                async with client.stream("POST", "/api/agent-runs/stream", json=payload) as upstream:
                    buffer = ""
                    async for chunk in upstream.aiter_bytes():
                        yield chunk  # 透传给前端
                        buffer += chunk.decode("utf-8", errors="ignore")
                        frames = re.split(r"\r?\n\r?\n", buffer)
                        buffer = frames.pop() or ""
                        for frame in frames:
                            parsed = _parse_sse_frame(frame)
                            if not parsed:
                                continue
                            event, payload_data = parsed
                            if event == "answer_delta":
                                answer_parts.append(str(payload_data.get("content", "")))
                            elif event == "result":
                                answer = payload_data.get("answer") or {}
                                if answer.get("content"):
                                    answer_parts = [str(answer["content"])]
                                sources = answer.get("sources") or []
                                meta = answer.get("trace_summary") or {}
                                logger.info(
                                    "chat run result: session=%s answer_len=%s meta=%s",
                                    session_id,
                                    len("".join(answer_parts)),
                                    {k: v for k, v in meta.items() if k != "token_usage"},
                                )
                                await persist_assistant("".join(answer_parts), sources, meta)
                                answer_parts = []
                            elif event == "error":
                                detail = str(payload_data.get("detail", "出错了"))
                                logger.warning("chat run error: session=%s detail=%s", session_id, detail)
                                await persist_assistant(f"⚠️ {detail}", [], {"error": True})
                                answer_parts = []
        except Exception as exc:  # gateway 不可达等情况
            logger.error("chat relay failed: session=%s error=%s", session_id, exc, exc_info=True)
            error_frame = _sse_frame("error", {"run_id": "", "detail": f"agent 服务不可用: {str(exc)[:200]}", "error_type": "gateway_unreachable"})
            yield error_frame.encode("utf-8")
            await persist_assistant(f"⚠️ agent 服务不可用: {str(exc)[:200]}", [], {"error": True})

        # 流正常结束但未收到 result：兜底保存已累积内容
        if answer_parts:
            content = "".join(answer_parts).strip()
            if content:
                await persist_assistant(content, sources, meta)

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/sessions/{session_id}/messages")
async def add_message(session_id: str, data: SendMessageRequest, db: AsyncSession = Depends(get_db)):
    """非流式发送（同步返回助手回答），适合快速问答。"""
    question = data.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="问题不能为空")
    session = await _load_session_or_404(db, session_id)
    paper_id = data.paper_id.strip() or (session.paper_id or "")
    history = await _build_history(db, session_id)
    await _persist_message(db, session_id, role="user", content=question)

    payload = {
        "input": {"question": question, "paper_id": paper_id or None},
        "context": {
            "paper_id": paper_id or None,
            "session_id": f"chat-{session_id}",
            "selected_text": data.selected_text or None,
        },
        "history": history,
    }
    async with _client() as client:
        upstream = await client.post("/api/agent-runs", json=payload)
        if upstream.status_code != 200:
            detail = f"agent 服务错误: {upstream.status_code}"
            await _persist_message(db, session_id, role="assistant", content=f"⚠️ {detail}", meta={"error": True})
            raise HTTPException(status_code=502, detail=detail)
        result = upstream.json()

    answer = result.get("answer") or {}
    await _persist_message(
        db,
        session_id,
        role="assistant",
        content=answer.get("content") or "",
        sources=answer.get("sources") or [],
        meta=answer.get("trace_summary") or {},
    )
    return result


# 延迟导入避免循环依赖（async_session_factory 在 database 模块）
from app.database import async_session_factory  # noqa: E402
