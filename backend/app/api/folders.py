"""文件夹与标签 API - 论文组织管理"""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.folder import Folder
from app.models.paper import Paper

router = APIRouter(prefix="/api/folders", tags=["文件夹与标签"])


def _folder_to_dict(folder: Folder, paper_count: int = 0) -> dict:
    return {
        "id": folder.id,
        "name": folder.name,
        "parent_id": folder.parent_id or "",
        "icon": folder.icon,
        "color": folder.color,
        "sort_order": folder.sort_order,
        "paper_count": paper_count,
        "created_at": folder.created_at.isoformat() if folder.created_at else "",
    }


async def _load_folder_or_404(db: AsyncSession, folder_id: str) -> Folder:
    folder = (await db.execute(select(Folder).where(Folder.id == folder_id))).scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    return folder


@router.get("")
async def list_folders(db: AsyncSession = Depends(get_db)):
    """文件夹列表（含每组论文数）。"""
    folders = (
        await db.execute(select(Folder).order_by(Folder.sort_order.asc(), Folder.created_at.asc()))
    ).scalars().all()

    counts = dict(
        (await db.execute(
            select(Paper.folder_id, func.count()).group_by(Paper.folder_id)
        )).all()
    )
    uncategorized = counts.pop("", 0)
    return {
        "folders": [_folder_to_dict(f, counts.get(f.id, 0)) for f in folders],
        "uncategorized_count": uncategorized,
        "total_count": sum(counts.values()) + uncategorized,
    }


class FolderRequest(BaseModel):
    name: str
    parent_id: str = ""
    icon: str = "folder"
    color: str = ""
    sort_order: int = 0


@router.post("")
async def create_folder(data: FolderRequest, db: AsyncSession = Depends(get_db)):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="文件夹名不能为空")
    folder = Folder(
        name=name,
        parent_id=data.parent_id.strip(),
        icon=data.icon or "folder",
        color=data.color,
        sort_order=data.sort_order,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return _folder_to_dict(folder)


@router.patch("/{folder_id}")
async def update_folder(folder_id: str, data: FolderRequest, db: AsyncSession = Depends(get_db)):
    folder = await _load_folder_or_404(db, folder_id)
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="文件夹名不能为空")
    if data.parent_id.strip() == folder_id:
        raise HTTPException(status_code=400, detail="不能将文件夹移动到自身")
    folder.name = name
    folder.parent_id = data.parent_id.strip()
    folder.icon = data.icon or folder.icon
    folder.color = data.color
    folder.sort_order = data.sort_order
    folder.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(folder)
    return _folder_to_dict(folder)


@router.delete("/{folder_id}")
async def delete_folder(folder_id: str, db: AsyncSession = Depends(get_db)):
    """删除文件夹：其中论文移回「未分组」。"""
    folder = await _load_folder_or_404(db, folder_id)
    # 子文件夹移动到根级
    children = (await db.execute(select(Folder).where(Folder.parent_id == folder_id))).scalars().all()
    for child in children:
        child.parent_id = ""
    # 论文移回未分组
    papers = (await db.execute(select(Paper).where(Paper.folder_id == folder_id))).scalars().all()
    for paper in papers:
        paper.folder_id = ""
    await db.delete(folder)
    await db.commit()
    return {"status": "ok", "deleted": folder_id, "moved_papers": len(papers)}


# ---------- 论文的文件夹/标签操作 ----------

class AssignFolderRequest(BaseModel):
    folder_id: str = ""  # 空串 = 移出文件夹


@router.put("/assign/{paper_id}")
async def assign_paper_folder(paper_id: str, data: AssignFolderRequest, db: AsyncSession = Depends(get_db)):
    paper = (await db.execute(select(Paper).where(Paper.id == paper_id))).scalar_one_or_none()
    if not paper:
        raise HTTPException(status_code=404, detail="论文不存在")
    folder_id = data.folder_id.strip()
    if folder_id:
        await _load_folder_or_404(db, folder_id)  # 校验文件夹存在
    paper.folder_id = folder_id
    await db.commit()
    return {"status": "ok", "paper_id": paper_id, "folder_id": folder_id}


class TagsRequest(BaseModel):
    tags: list[str]


@router.put("/tags/{paper_id}")
async def set_paper_tags(paper_id: str, data: TagsRequest, db: AsyncSession = Depends(get_db)):
    paper = (await db.execute(select(Paper).where(Paper.id == paper_id))).scalar_one_or_none()
    if not paper:
        raise HTTPException(status_code=404, detail="论文不存在")
    cleaned = []
    for tag in data.tags:
        t = tag.strip()
        if t and t not in cleaned:
            cleaned.append(t)
    paper.tags = json.dumps(cleaned[:20], ensure_ascii=False)
    await db.commit()
    return {"status": "ok", "paper_id": paper_id, "tags": cleaned}


@router.get("/tags/all")
async def list_all_tags(db: AsyncSession = Depends(get_db)):
    """全部已用标签（按使用次数排序）。"""
    papers = (await db.execute(select(Paper.tags))).scalars().all()
    counter: dict[str, int] = {}
    for raw in papers:
        try:
            for tag in json.loads(raw or "[]"):
                counter[tag] = counter.get(tag, 0) + 1
        except Exception:
            continue
    ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    return {"tags": [{"name": name, "count": count} for name, count in ordered]}
