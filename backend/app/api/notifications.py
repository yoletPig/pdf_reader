"""消息通知 API - 全局收件箱"""
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.notification import Notification
from app.models.todo import Todo

router = APIRouter(prefix="/api/notifications", tags=["消息通知"])


def _iso(dt: datetime | None) -> str:
    if not dt:
        return ""
    text = dt.isoformat()
    return text if text.endswith("Z") else f"{text}Z"


def _to_dict(n: Notification) -> dict:
    return {
        "id": n.id,
        "type": n.type,
        "title": n.title,
        "body": n.body or "",
        "link": n.link or "",
        "read": bool(n.read),
        "created_at": _iso(n.created_at),
        "read_at": _iso(n.read_at),
    }


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


async def _exists(db: AsyncSession, dedupe_key: str) -> bool:
    row = (await db.execute(select(Notification.id).where(Notification.dedupe_key == dedupe_key))).first()
    return row is not None


async def collect_notifications(db: AsyncSession) -> None:
    """幂等生成提醒类消息（待办到期/逾期、每日论文更新）。"""
    # 1) 待办到期 / 逾期提醒
    todos = (
        await db.execute(select(Todo).where(Todo.status == "pending", Todo.due_date != ""))
    ).scalars().all()
    today = _today()
    for todo in todos:
        due = todo.due_date or ""
        if not due:
            continue
        if due < today:
            key = f"todo:{todo.id}:{due}"
            if not await _exists(db, key):
                db.add(Notification(
                    type="todo",
                    title="⚠️ 待办已逾期",
                    body=todo.title,
                    link="/todos",
                    dedupe_key=key,
                ))
        elif due == today:
            key = f"todo:{todo.id}:{due}"
            if not await _exists(db, key):
                db.add(Notification(
                    type="todo",
                    title="⏰ 待办今日到期",
                    body=todo.title,
                    link="/todos",
                    dedupe_key=key,
                ))

    # 2) 每日论文更新提醒（由 daily-papers 接口写缓存后触发，此处兜底检查）
    from app.services.daily_papers import _cache_dir  # 延迟导入避免循环依赖

    key = f"papers:{today}"
    if not await _exists(db, key):
        cache_dir = _cache_dir()
        has_today = any(
            p.is_file() and p.stat().st_mtime >= datetime.now().timestamp() - 36 * 3600
            for p in cache_dir.glob("*.json")
        )
        if has_today:
            db.add(Notification(
                type="papers",
                title="📚 每日论文已更新",
                body="今日 HuggingFace / ModelScope 论文推荐已就绪，点击查看",
                link="/#papers",
                dedupe_key=key,
            ))
    await db.commit()


@router.get("")
async def list_notifications(limit: int = 30, db: AsyncSession = Depends(get_db)):
    """收件箱消息列表（先幂等补生成提醒消息）。"""
    await collect_notifications(db)
    rows = (
        await db.execute(select(Notification).order_by(Notification.created_at.desc()).limit(min(limit, 100)))
    ).scalars().all()
    unread = (await db.execute(
        select(Notification).where(Notification.read == False)  # noqa: E712
    )).scalars().all()
    return {
        "notifications": [_to_dict(n) for n in rows],
        "unread_count": len(unread),
    }


class ReadRequest(BaseModel):
    read: bool = True


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, db: AsyncSession = Depends(get_db)):
    note = (await db.execute(
        select(Notification).where(Notification.id == notification_id)
    )).scalar_one_or_none()
    if note:
        note.read = True
        note.read_at = datetime.utcnow()
        await db.commit()
    return {"status": "ok"}


@router.post("/read-all")
async def mark_all_read(db: AsyncSession = Depends(get_db)):
    """一键全读。"""
    rows = (await db.execute(select(Notification).where(Notification.read == False))).scalars().all()  # noqa: E712
    now = datetime.utcnow()
    for note in rows:
        note.read = True
        note.read_at = now
    await db.commit()
    return {"status": "ok", "marked": len(rows)}


@router.delete("/{notification_id}")
async def delete_notification(notification_id: str, db: AsyncSession = Depends(get_db)):
    note = (await db.execute(
        select(Notification).where(Notification.id == notification_id)
    )).scalar_one_or_none()
    if note:
        await db.delete(note)
        await db.commit()
    return {"status": "ok", "deleted": notification_id}


@router.delete("")
async def clear_read_notifications(db: AsyncSession = Depends(get_db)):
    """清空已读消息。"""
    rows = (await db.execute(select(Notification).where(Notification.read == True))).scalars().all()  # noqa: E712
    for note in rows:
        await db.delete(note)
    await db.commit()
    return {"status": "ok", "cleared": len(rows)}
