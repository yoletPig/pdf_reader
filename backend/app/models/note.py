"""笔记模型 - Markdown 笔记"""
import uuid
from datetime import datetime
from sqlalchemy import String, Text, DateTime, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class Note(Base):
    """Markdown 笔记（支持手动创建 / 从 AI 对话生成）"""

    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(500), default="")
    content_md: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[str] = mapped_column(Text, default="[]")  # JSON 数组字符串
    paper_id: Mapped[str] = mapped_column(String(36), default="", index=True)  # 空串 = 不关联论文
    template_id: Mapped[str] = mapped_column(String(50), default="")  # 创建时使用的模板
    source_type: Mapped[str] = mapped_column(String(20), default="manual")  # manual / chat
    source_ref: Mapped[str] = mapped_column(Text, default="{}")  # JSON：来源信息（会话/消息等）
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
