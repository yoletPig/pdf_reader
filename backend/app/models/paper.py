"""论文数据模型"""
import uuid
from datetime import datetime
from sqlalchemy import String, Integer, Float, DateTime, Text, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class Paper(Base):
    __tablename__ = "papers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    authors: Mapped[str] = mapped_column(Text, default="[]")  # JSON list
    abstract: Mapped[str] = mapped_column(Text, default="")
    year: Mapped[int] = mapped_column(Integer, nullable=True, default=None)
    source: Mapped[str] = mapped_column(String(50), default="local")  # arxiv / semantic_scholar / local
    source_id: Mapped[str] = mapped_column(String(200), default="")
    source_url: Mapped[str] = mapped_column(String(1000), default="")
    document_type: Mapped[str] = mapped_column(String(50), default="pdf")
    file_path: Mapped[str] = mapped_column(String(1000), default="")
    markdown_path: Mapped[str] = mapped_column(String(1000), default="")
    tags: Mapped[str] = mapped_column(Text, default="[]")  # JSON list
    folder_id: Mapped[str] = mapped_column(String(36), default="", index=True)  # 空串 = 未分组
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    pdf_metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    ai_summary_md: Mapped[str] = mapped_column(Text, default="")
    reader_profile_json: Mapped[str] = mapped_column(Text, default="{}")
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_read_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    read_progress: Mapped[float] = mapped_column(Float, default=0.0)  # 0.0 - 1.0
    is_indexed: Mapped[bool] = mapped_column(Boolean, default=False)  # 是否已向量化入库

    translation_caches: Mapped[list] = relationship("TranslationCache", back_populates="paper", cascade="all, delete-orphan")
