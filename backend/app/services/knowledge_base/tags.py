"""标签/分类管理"""
from app.services.knowledge_base.manager import kb_manager


class TagsManager:
    """标签管理器"""

    def add(self, tag: str):
        """添加标签"""
        kb_manager.add_tag(tag.strip().lower())

    def list_all(self) -> list[str]:
        """列出所有标签"""
        return kb_manager.get_all_tags()

    def tag_paper(self, paper_id: str, tag: str):
        """为论文打标签"""
        paper = kb_manager.get_paper(paper_id)
        if paper:
            tags = paper.get("tags", [])
            tag = tag.strip().lower()
            if tag not in tags:
                tags.append(tag)
                paper["tags"] = tags
                self.add(tag)

    def untag_paper(self, paper_id: str, tag: str):
        """移除论文标签"""
        paper = kb_manager.get_paper(paper_id)
        if paper:
            tags = paper.get("tags", [])
            tag = tag.strip().lower()
            if tag in tags:
                tags.remove(tag)
                paper["tags"] = tags

    def get_papers_by_tag(self, tag: str) -> list[dict]:
        """按标签获取论文"""
        papers, _ = kb_manager.list_papers(tag=tag.strip().lower(), page_size=1000)
        return papers


# 全局单例
tags_manager = TagsManager()
