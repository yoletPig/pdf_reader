"""知识库管理器 - 论文 CRUD 操作"""
import os
import uuid
import json
from pathlib import Path
from typing import Optional
from datetime import datetime
from app.config import settings


class KnowledgeBaseManager:
    """知识库管理 - 论文 CRUD + 统计"""

    def __init__(self):
        self._papers: dict[str, dict] = {}
        self._notes: dict[str, list[dict]] = {}
        self._tags: set[str] = set()

    def add_paper(self, paper_data: dict) -> str:
        """添加论文"""
        paper_id = paper_data.get("id", str(uuid.uuid4()))
        paper_data["id"] = paper_id
        paper_data.setdefault("added_at", datetime.utcnow().isoformat())
        paper_data.setdefault("tags", [])
        paper_data.setdefault("read_progress", 0.0)
        paper_data.setdefault("is_indexed", False)
        self._papers[paper_id] = paper_data
        return paper_id

    def get_paper(self, paper_id: str) -> Optional[dict]:
        """获取论文"""
        return self._papers.get(paper_id)

    def list_papers(
        self,
        page: int = 1,
        page_size: int = 20,
        tag: Optional[str] = None,
        sort_by: str = "added_at",
    ) -> tuple[list[dict], int]:
        """列出论文"""
        papers = list(self._papers.values())

        # 按标签过滤
        if tag:
            papers = [p for p in papers if tag in p.get("tags", [])]

        # 排序
        papers.sort(key=lambda p: p.get(sort_by, ""), reverse=True)

        total = len(papers)
        start = (page - 1) * page_size
        end = start + page_size
        return papers[start:end], total

    def update_paper(self, paper_id: str, data: dict) -> Optional[dict]:
        """更新论文"""
        if paper_id not in self._papers:
            return None
        self._papers[paper_id].update(data)
        return self._papers[paper_id]

    def delete_paper(self, paper_id: str) -> bool:
        """删除论文"""
        if paper_id in self._papers:
            del self._papers[paper_id]

            # 删除文件
            paper_dir = settings.PAPERS_DIR / paper_id
            if paper_dir.exists():
                import shutil
                shutil.rmtree(paper_dir)

            # 清理笔记
            self._notes.pop(paper_id, None)
            return True
        return False

    def add_note(self, paper_id: str, note_data: dict) -> str:
        """添加笔记"""
        note_id = note_data.get("id", str(uuid.uuid4()))
        note_data["id"] = note_id
        note_data.setdefault("created_at", datetime.utcnow().isoformat())

        if paper_id not in self._notes:
            self._notes[paper_id] = []
        self._notes[paper_id].append(note_data)
        return note_id

    def get_notes(self, paper_id: str) -> list[dict]:
        """获取论文笔记"""
        return self._notes.get(paper_id, [])

    def update_note(self, note_id: str, data: dict) -> Optional[dict]:
        """更新笔记"""
        for paper_notes in self._notes.values():
            for note in paper_notes:
                if note.get("id") == note_id:
                    note.update(data)
                    return note
        return None

    def delete_note(self, note_id: str) -> bool:
        """删除笔记"""
        for paper_id, paper_notes in self._notes.items():
            for i, note in enumerate(paper_notes):
                if note.get("id") == note_id:
                    paper_notes.pop(i)
                    return True
        return False

    def add_tag(self, tag: str):
        """添加标签"""
        self._tags.add(tag)

    def get_all_tags(self) -> list[str]:
        """获取所有标签"""
        return sorted(self._tags)

    def get_stats(self) -> dict:
        """获取知识库统计"""
        total_chunks = sum(
            p.get("chunk_count", 0) for p in self._papers.values()
        )
        return {
            "total_papers": len(self._papers),
            "total_chunks": total_chunks,
            "total_notes": sum(len(notes) for notes in self._notes.values()),
            "total_tags": len(self._tags),
        }


# 全局单例
kb_manager = KnowledgeBaseManager()
