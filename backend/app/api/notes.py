"""笔记 API"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db

router = APIRouter(prefix="/api/notes", tags=["笔记"])


@router.get("/{paper_id}")
async def get_notes(paper_id: str, db: AsyncSession = Depends(get_db)):
    """获取论文笔记"""
    return {"paper_id": paper_id, "notes": []}


@router.post("")
async def create_note(data: dict, db: AsyncSession = Depends(get_db)):
    """创建笔记"""
    return {"message": "创建成功", "note": data}


@router.put("/{note_id}")
async def update_note(note_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    """更新笔记"""
    return {"message": "更新成功", "note_id": note_id}


@router.delete("/{note_id}")
async def delete_note(note_id: str, db: AsyncSession = Depends(get_db)):
    """删除笔记"""
    return {"message": "删除成功", "note_id": note_id}
