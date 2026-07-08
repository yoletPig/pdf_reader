"""笔记管理"""
import uuid
from typing import Optional
from datetime import datetime
from app.services.knowledge_base.manager import kb_manager


class NotesManager:
    """笔记管理器"""

    def create(
        self,
        paper_id: str,
        content: str,
        block_id: str = "",
        page_number: int = 0,
        note_type: str = "annotation",
        position: dict = {},
    ) -> dict:
        """创建笔记"""
        note = {
            "id": str(uuid.uuid4()),
            "paper_id": paper_id,
            "block_id": block_id,
            "page_number": page_number,
            "content": content,
            "note_type": note_type,
            "position": position,
            "created_at": datetime.utcnow().isoformat(),
        }
        kb_manager.add_note(paper_id, note)
        return note

    def list_by_paper(self, paper_id: str) -> list[dict]:
        """获取论文的所有笔记"""
        return kb_manager.get_notes(paper_id)

    def update(self, note_id: str, data: dict) -> Optional[dict]:
        """更新笔记"""
        return kb_manager.update_note(note_id, data)

    def delete(self, note_id: str) -> bool:
        """删除笔记"""
        return kb_manager.delete_note(note_id)


# 全局单例
notes_manager = NotesManager()
