"""系统设置数据模型 - 运行时可编辑的键值配置"""
from datetime import datetime
from sqlalchemy import String, Text, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class AppSetting(Base):
    """键值对形式的系统设置，供前端设置页读写。

    与 .env 静态配置互补：.env 提供默认值/引导配置，
    本表保存用户在系统设置页中显式保存的覆盖值。
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text, default="null")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
