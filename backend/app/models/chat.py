"""对话会话与消息模型 - 持久化 pi agent 对话历史"""
import uuid
from datetime import datetime
from sqlalchemy import String, Text, DateTime, Integer, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class ChatSession(Base):
    """一个对话会话，可绑定论文范围（paper_id 为空 = 全部论文）"""

    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(200), default="新对话")
    paper_id: Mapped[str] = mapped_column(String(36), default="")  # 空串 = 全部论文
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    messages: Mapped[list["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="session", cascade="all, delete-orphan", order_by="ChatMessage.sequence"
    )


class ChatMessage(Base):
    """对话消息（用户或助手）"""

    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    role: Mapped[str] = mapped_column(String(20), default="user")  # user / assistant
    content: Mapped[str] = mapped_column(Text, default="")
    # JSON: 引用来源 [{paper_id, paper_title, page, ...}]
    sources_json: Mapped[str] = mapped_column(Text, default="[]")
    # JSON: 追踪信息（tool_calls / tools_used / llm_calls 等）
    meta_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped["ChatSession"] = relationship("ChatSession", back_populates="messages")
