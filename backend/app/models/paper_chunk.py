"""持久化的 RAG chunk"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PaperChunk(Base):
    __tablename__ = "paper_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    paper_id: Mapped[str] = mapped_column(String(36), ForeignKey("papers.id"), nullable=False, index=True)
    chunk_id: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    page_number: Mapped[int] = mapped_column(Integer, default=1, index=True)
    block_id: Mapped[str] = mapped_column(String(100), default="", index=True)
    text: Mapped[str] = mapped_column(Text, default="")
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
