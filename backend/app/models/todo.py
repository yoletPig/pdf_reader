"""待办事项模型 - 个人任务清单"""
import uuid
from datetime import datetime
from sqlalchemy import String, Text, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class Todo(Base):
    """待办事项"""

    __tablename__ = "todos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(500), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending / done
    priority: Mapped[str] = mapped_column(String(20), default="medium")  # low / medium / high
    due_date: Mapped[str] = mapped_column(String(10), default="")  # YYYY-MM-DD，空串 = 无期限
    source_type: Mapped[str] = mapped_column(String(20), default="manual")  # manual / chat / note
    source_ref: Mapped[str] = mapped_column(Text, default="{}")  # JSON：来源信息（会话/笔记等）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
