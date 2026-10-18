"""文件夹模型 - 论文分组管理"""
import uuid
from datetime import datetime
from sqlalchemy import String, Text, DateTime, Integer
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class Folder(Base):
    """论文文件夹（支持嵌套：parent_id）"""

    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200), default="")
    parent_id: Mapped[str] = mapped_column(String(36), default="", index=True)  # 空串 = 根级
    icon: Mapped[str] = mapped_column(String(50), default="folder")  # emoji 或图标名
    color: Mapped[str] = mapped_column(String(20), default="")  # 可选颜色标记
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
