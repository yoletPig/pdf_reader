"""待办事项 API - 个人任务清单（支持自定义列表）"""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.todo import Todo, TodoList

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
        "list_id": todo.list_id or "",
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


# ---------- 待办列表（自定义分组） ----------


def _list_to_dict(todo_list: TodoList, pending_count: int = 0, done_count: int = 0) -> dict:
    return {
        "id": todo_list.id,
        "name": todo_list.name,
        "icon": todo_list.icon,
        "color": todo_list.color,
        "sort_order": todo_list.sort_order,
        "pending_count": pending_count,
        "done_count": done_count,
        "created_at": _iso(todo_list.created_at),
    }


async def _load_list_or_404(db: AsyncSession, list_id: str) -> TodoList:
    todo_list = (await db.execute(select(TodoList).where(TodoList.id == list_id))).scalar_one_or_none()
    if not todo_list:
        raise HTTPException(status_code=404, detail="待办列表不存在")
    return todo_list


@router.get("/lists")
async def todo_lists(db: AsyncSession = Depends(get_db)):
    """所有待办列表（含每个列表的待办计数）+ 收件箱计数。"""
    lists = (
        await db.execute(select(TodoList).order_by(TodoList.sort_order.asc(), TodoList.created_at.asc()))
    ).scalars().all()

    counts: dict[str, list[int]] = {}
    rows = (await db.execute(
        select(Todo.list_id, Todo.status, func.count()).group_by(Todo.list_id, Todo.status)
    )).all()
    for list_id, status, cnt in rows:
        slot = counts.setdefault(list_id or "", [0, 0])
        if status == "done":
            slot[1] += cnt
        else:
            slot[0] += cnt

    inbox = counts.get("", [0, 0])
    return {
        "lists": [_list_to_dict(t, *counts.get(t.id, [0, 0])) for t in lists],
        "inbox": {"pending_count": inbox[0], "done_count": inbox[1]},
    }


class TodoListRequest(BaseModel):
    name: str
    icon: str = "📋"
    color: str = ""


@router.post("/lists")
async def create_todo_list(data: TodoListRequest, db: AsyncSession = Depends(get_db)):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="列表名不能为空")
    todo_list = TodoList(name=name, icon=data.icon or "📋", color=data.color)
    db.add(todo_list)
    await db.commit()
    await db.refresh(todo_list)
    return _list_to_dict(todo_list)


@router.patch("/lists/{list_id}")
async def update_todo_list(list_id: str, data: TodoListRequest, db: AsyncSession = Depends(get_db)):
    todo_list = await _load_list_or_404(db, list_id)
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="列表名不能为空")
    todo_list.name = name
    todo_list.icon = data.icon or todo_list.icon
    todo_list.color = data.color
    todo_list.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(todo_list)
    return _list_to_dict(todo_list)


@router.delete("/lists/{list_id}")
async def delete_todo_list(list_id: str, db: AsyncSession = Depends(get_db)):
    """删除列表：其中待办移回收件箱。"""
    todo_list = await _load_list_or_404(db, list_id)
    todos = (await db.execute(select(Todo).where(Todo.list_id == list_id))).scalars().all()
    for todo in todos:
        todo.list_id = ""
    await db.delete(todo_list)
    await db.commit()
    return {"status": "ok", "deleted": list_id, "moved_todos": len(todos)}


# ---------- 待办条目 ----------


@router.get("")
async def list_todos(
    status: str = "all",
    q: str = "",
    list_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """待办列表。status: all / pending / done；list_id 不传 = 全部，传空串 = 收件箱"""
    query = select(Todo)
    if status in ("pending", "done"):
        query = query.where(Todo.status == status)
    if list_id is not None:
        query = query.where(Todo.list_id == list_id)
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
    list_id: str = ""
    source_type: str = "manual"
    source_ref: dict = Field(default_factory=dict)


class TodoUpdateRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    due_date: str | None = None
    list_id: str | None = None


_PRIORITIES = {"low", "medium", "high"}
_STATUSES = {"pending", "done"}


@router.post("")
async def create_todo(data: TodoCreateRequest, db: AsyncSession = Depends(get_db)):
    title = data.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="待办标题不能为空")
    if data.priority not in _PRIORITIES:
        raise HTTPException(status_code=400, detail="priority 仅支持 low/medium/high")
    list_id = data.list_id.strip()
    if list_id:
        await _load_list_or_404(db, list_id)  # 校验列表存在

    todo = Todo(
        title=title,
        description=data.description.strip(),
        status="pending",
        priority=data.priority,
        due_date=_validate_due_date(data.due_date),
        list_id=list_id,
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
    if data.list_id is not None:
        list_id = data.list_id.strip()
        if list_id:
            await _load_list_or_404(db, list_id)  # 校验列表存在
        todo.list_id = list_id

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
