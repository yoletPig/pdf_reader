"""笔记 API - Markdown 笔记管理 + 图片上传"""
import json
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.note import Note

router = APIRouter(prefix="/api/notes", tags=["笔记"])

# 图片上传限制
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10MB


def _iso(dt: datetime | None) -> str:
    """naive UTC → ISO 字符串（带 Z，避免前端按本地时区误解析）。"""
    if not dt:
        return ""
    text = dt.isoformat()
    return text if text.endswith("Z") else f"{text}Z"


def _snippet(content_md: str, limit: int = 160) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", content_md or "")  # 去图片
    text = re.sub(r"[#>*`~\-]+", " ", text)  # 去 markdown 标记
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _note_to_dict(note: Note, with_content: bool = False) -> dict:
    try:
        tags = json.loads(note.tags or "[]")
    except json.JSONDecodeError:
        tags = []
    try:
        source_ref = json.loads(note.source_ref or "{}")
    except json.JSONDecodeError:
        source_ref = {}
    data = {
        "id": note.id,
        "title": note.title,
        "snippet": _snippet(note.content_md),
        "tags": tags,
        "paper_id": note.paper_id or "",
        "template_id": note.template_id or "",
        "source_type": note.source_type,
        "source_ref": source_ref,
        "pinned": bool(note.pinned),
        "created_at": _iso(note.created_at),
        "updated_at": _iso(note.updated_at),
    }
    if with_content:
        data["content_md"] = note.content_md or ""
    return data


async def _load_note_or_404(db: AsyncSession, note_id: str) -> Note:
    note = (await db.execute(select(Note).where(Note.id == note_id))).scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="笔记不存在")
    return note


def _clean_tags(tags: list[str] | None) -> str:
    cleaned: list[str] = []
    for tag in tags or []:
        t = str(tag).strip()
        if t and t not in cleaned:
            cleaned.append(t)
    return json.dumps(cleaned[:20], ensure_ascii=False)


@router.get("")
async def list_notes(
    q: str = "",
    tag: str = "",
    paper_id: str = "",
    source_type: str = "",
    db: AsyncSession = Depends(get_db),
):
    """笔记列表（不含正文）。"""
    query = select(Note).order_by(Note.pinned.desc(), Note.updated_at.desc())
    if paper_id:
        query = query.where(Note.paper_id == paper_id)
    if source_type:
        query = query.where(Note.source_type == source_type)
    notes = (await db.execute(query)).scalars().all()

    keyword = q.strip().lower()
    items = []
    for note in notes:
        data = _note_to_dict(note)
        if tag and tag not in data["tags"]:
            continue
        if keyword and keyword not in f"{data['title']} {data['snippet']}".lower():
            continue
        items.append(data)

    all_tags: dict[str, int] = {}
    for note in notes:
        for t in _note_to_dict(note)["tags"]:
            all_tags[t] = all_tags.get(t, 0) + 1

    return {
        "notes": items,
        "total_count": len(notes),
        "tags": [{"name": name, "count": count} for name, count in sorted(all_tags.items())],
    }


class NoteCreateRequest(BaseModel):
    title: str = ""
    content_md: str = ""
    tags: list[str] = Field(default_factory=list)
    paper_id: str = ""
    template_id: str = ""
    source_type: str = "manual"
    source_ref: dict = Field(default_factory=dict)
    pinned: bool = False


@router.post("")
async def create_note(data: NoteCreateRequest, db: AsyncSession = Depends(get_db)):
    note = Note(
        title=data.title.strip(),
        content_md=data.content_md,
        tags=_clean_tags(data.tags),
        paper_id=data.paper_id.strip(),
        template_id=data.template_id.strip(),
        source_type=data.source_type or "manual",
        source_ref=json.dumps(data.source_ref or {}, ensure_ascii=False),
        pinned=data.pinned,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return _note_to_dict(note, with_content=True)


@router.get("/{note_id}")
async def get_note(note_id: str, db: AsyncSession = Depends(get_db)):
    note = await _load_note_or_404(db, note_id)
    return _note_to_dict(note, with_content=True)


class NoteUpdateRequest(BaseModel):
    title: str | None = None
    content_md: str | None = None
    tags: list[str] | None = None
    paper_id: str | None = None
    pinned: bool | None = None


@router.patch("/{note_id}")
async def update_note(note_id: str, data: NoteUpdateRequest, db: AsyncSession = Depends(get_db)):
    note = await _load_note_or_404(db, note_id)
    if data.title is not None:
        note.title = data.title.strip()
    if data.content_md is not None:
        note.content_md = data.content_md
    if data.tags is not None:
        note.tags = _clean_tags(data.tags)
    if data.paper_id is not None:
        note.paper_id = data.paper_id.strip()
    if data.pinned is not None:
        note.pinned = data.pinned
    note.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(note)
    return _note_to_dict(note, with_content=True)


@router.delete("/{note_id}")
async def delete_note(note_id: str, db: AsyncSession = Depends(get_db)):
    note = await _load_note_or_404(db, note_id)
    await db.delete(note)
    await db.commit()
    return {"status": "ok", "deleted": note_id}


# ---------- 笔记图片 ----------

def _images_dir() -> Path:
    images_dir = settings.NOTES_DIR / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    return images_dir


@router.post("/images")
async def upload_note_image(file: UploadFile = File(...)):
    """上传笔记图片，返回可直接写入 markdown 的 URL。"""
    ext = Path(file.filename or "").suffix.lower()
    if ext not in _IMAGE_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 png/jpg/jpeg/gif/webp 图片")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="图片内容为空")
    if len(content) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="图片大小不能超过 10MB")

    filename = f"{uuid.uuid4().hex}{ext}"
    (_images_dir() / filename).write_bytes(content)
    return {"filename": filename, "url": f"/api/notes/images/{filename}"}


@router.get("/images/{filename}")
async def get_note_image(filename: str):
    """返回笔记图片（含路径穿越防护）。"""
    root = _images_dir().resolve()
    target = (root / filename).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(status_code=404, detail="图片不存在")
    return FileResponse(path=str(target), filename=target.name)
