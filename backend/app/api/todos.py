"""待办事项 API - 个人任务清单"""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.todo import Todo

router = APIRouter(prefix="/api/todos", tags=["待办事项"])


def _iso(dt: datetime | None) -> str:
    """naive UTC → ISO 字符串（带 Z，避免前端按本地时区误解析）。"""
    if not dt:
        return ""
    text = dt.isoformat()
    return text if text.endswith("Z") else f"{text}Z"


def _todo_to_dict(todo: Todo) -> dict:
    return {
        "id": todo.id,
        "title": todo.title,
        "description": todo.description or "",
        "status": todo.status,
        "priority": todo.priority,
        "due_date": todo.due_date or "",
        "source_type": todo.source_type,
        "created_at": _iso(todo.created_at),
        "updated_at": _iso(todo.updated_at),
        "completed_at": _iso(todo.completed_at),
    }


async def _load_todo_or_404(db: AsyncSession, todo_id: str) -> Todo:
    todo = (await db.execute(select(Todo).where(Todo.id == todo_id))).scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="待办事项不存在")
    return todo


def _validate_due_date(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="截止日期格式应为 YYYY-MM-DD")
    return value


@router.get("")
async def list_todos(status: str = "all", q: str = "", db: AsyncSession = Depends(get_db)):
    """待办列表。status: all / pending / done"""
    query = select(Todo)
    if status in ("pending", "done"):
        query = query.where(Todo.status == status)
    query = query.order_by(
        Todo.status.asc(),  # pending 在前
        Todo.due_date.asc(),
        Todo.priority.desc(),
        Todo.created_at.desc(),
    )
    todos = (await db.execute(query)).scalars().all()

    keyword = q.strip().lower()
    items = []
    for todo in todos:
        data = _todo_to_dict(todo)
        if keyword and keyword not in f"{data['title']} {data['description']}".lower():
            continue
        items.append(data)

    all_todos = (await db.execute(select(Todo))).scalars().all()
    pending = sum(1 for t in all_todos if t.status == "pending")
    return {
        "todos": items,
        "total_count": len(all_todos),
        "pending_count": pending,
        "done_count": len(all_todos) - pending,
    }


class TodoCreateRequest(BaseModel):
    title: str
    description: str = ""
    priority: str = "medium"
    due_date: str = ""
    source_type: str = "manual"
    source_ref: dict = Field(default_factory=dict)


class TodoUpdateRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    due_date: str | None = None


_PRIORITIES = {"low", "medium", "high"}
_STATUSES = {"pending", "done"}


@router.post("")
async def create_todo(data: TodoCreateRequest, db: AsyncSession = Depends(get_db)):
    title = data.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="待办标题不能为空")
    if data.priority not in _PRIORITIES:
        raise HTTPException(status_code=400, detail="priority 仅支持 low/medium/high")

    todo = Todo(
        title=title,
        description=data.description.strip(),
        status="pending",
        priority=data.priority,
        due_date=_validate_due_date(data.due_date),
        source_type=data.source_type or "manual",
        source_ref=json.dumps(data.source_ref or {}, ensure_ascii=False),
    )
    db.add(todo)
    await db.commit()
    await db.refresh(todo)
    return _todo_to_dict(todo)


@router.patch("/{todo_id}")
async def update_todo(todo_id: str, data: TodoUpdateRequest, db: AsyncSession = Depends(get_db)):
    todo = await _load_todo_or_404(db, todo_id)

    if data.title is not None:
        title = data.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="待办标题不能为空")
        todo.title = title
    if data.description is not None:
        todo.description = data.description.strip()
    if data.status is not None:
        if data.status not in _STATUSES:
            raise HTTPException(status_code=400, detail="status 仅支持 pending/done")
        todo.status = data.status
        if data.status == "done" and not todo.completed_at:
            todo.completed_at = datetime.utcnow()
        if data.status == "pending":
            todo.completed_at = None
    if data.priority is not None:
        if data.priority not in _PRIORITIES:
            raise HTTPException(status_code=400, detail="priority 仅支持 low/medium/high")
        todo.priority = data.priority
    if data.due_date is not None:
        todo.due_date = _validate_due_date(data.due_date)

    todo.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(todo)
    return _todo_to_dict(todo)


@router.delete("/{todo_id}")
async def delete_todo(todo_id: str, db: AsyncSession = Depends(get_db)):
    todo = await _load_todo_or_404(db, todo_id)
    await db.delete(todo)
    await db.commit()
    return {"status": "ok", "deleted": todo_id}
