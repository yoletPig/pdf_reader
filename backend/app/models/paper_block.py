"""持久化的 PDF 文本块"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PaperBlock(Base):
    __tablename__ = "paper_blocks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    paper_id: Mapped[str] = mapped_column(String(36), ForeignKey("papers.id"), nullable=False, index=True)
    block_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    page_number: Mapped[int] = mapped_column(Integer, default=1, index=True)
    text: Mapped[str] = mapped_column(Text, default="")
    block_type: Mapped[str] = mapped_column(String(50), default="paragraph")
    bbox_json: Mapped[str] = mapped_column(Text, default="[]")
    section_title: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
