"""翻译缓存模型"""
import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, Text, Integer, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import ForeignKey
from app.database import Base


class TranslationCache(Base):
    __tablename__ = "translation_cache"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    paper_id: Mapped[str] = mapped_column(String(36), ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    block_id: Mapped[str] = mapped_column(String(100), default="")
    original_text: Mapped[str] = mapped_column(Text, default="")
    translated_text: Mapped[str] = mapped_column(Text, default="")
    mode: Mapped[str] = mapped_column(String(20), default="quick")  # quick / polish
    agent_mode: Mapped[str] = mapped_column(String(50), default="")  # 使用的 Agent 模式
    model_used: Mapped[str] = mapped_column(String(100), default="")
    finish_reason: Mapped[str] = mapped_column(String(50), default="")
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    source_text_length: Mapped[int] = mapped_column(Integer, default=0)
    translated_text_length: Mapped[int] = mapped_column(Integer, default=0)
    edited_by_user: Mapped[bool] = mapped_column(Boolean, default=False)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    user_notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # 关系
    paper: Mapped["Paper"] = relationship("Paper", back_populates="translation_caches")
