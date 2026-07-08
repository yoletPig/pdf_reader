"""Prompt 版本管理"""
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class PromptVersion:
    """Prompt 版本"""
    version: int
    content: str
    created_at: datetime = field(default_factory=datetime.utcnow)
    change_note: str = ""


class PromptVersionManager:
    """Prompt 版本管理器"""

    def __init__(self, max_versions: int = 20):
        self.max_versions = max_versions
        self._versions: dict[str, list[PromptVersion]] = {}
        self._active: dict[str, int] = {}  # template_id -> active version number

    def add_version(self, template_id: str, content: str, change_note: str = "") -> PromptVersion:
        """添加新版本"""
        if template_id not in self._versions:
            self._versions[template_id] = []

        versions = self._versions[template_id]
        new_version = len(versions) + 1
        pv = PromptVersion(version=new_version, content=content, change_note=change_note)
        versions.append(pv)

        # 限制最大版本数
        if len(versions) > self.max_versions:
            self._versions[template_id] = versions[-self.max_versions:]

        self._active[template_id] = new_version
        return pv

    def get_active(self, template_id: str) -> Optional[PromptVersion]:
        """获取当前活跃版本"""
        if template_id not in self._versions:
            return None
        active_ver = self._active.get(template_id, len(self._versions[template_id]))
        for pv in self._versions[template_id]:
            if pv.version == active_ver:
                return pv
        return self._versions[template_id][-1] if self._versions[template_id] else None

    def revert(self, template_id: str, target_version: int) -> Optional[PromptVersion]:
        """回退到指定版本"""
        if template_id not in self._versions:
            return None
        for pv in self._versions[template_id]:
            if pv.version == target_version:
                self._active[template_id] = target_version
                return pv
        return None

    def get_history(self, template_id: str) -> list[PromptVersion]:
        """获取版本历史"""
        return self._versions.get(template_id, [])


# 全局单例
version_manager = PromptVersionManager()
