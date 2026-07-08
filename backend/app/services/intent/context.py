"""上下文构建器"""
from typing import Optional
from app.services.intent.intent_types import SessionContext


class ContextBuilder:
    """构建会话上下文，用于意图识别的上下文感知"""

    def __init__(self):
        self._sessions: dict[str, SessionContext] = {}

    def get_or_create(self, session_id: str) -> SessionContext:
        """获取或创建会话上下文"""
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionContext()
        return self._sessions[session_id]

    def update(
        self,
        session_id: str,
        paper_id: Optional[str] = None,
        page: Optional[int] = None,
        selected_text: Optional[str] = None,
        selected_block_id: Optional[str] = None,
        operation: Optional[str] = None,
    ):
        """更新会话上下文"""
        ctx = self.get_or_create(session_id)
        if paper_id is not None:
            ctx.current_paper_id = paper_id
        if page is not None:
            ctx.current_page = page
        if selected_text is not None:
            ctx.selected_text = selected_text
        if selected_block_id is not None:
            ctx.selected_block_id = selected_block_id
        if operation is not None:
            ctx.recent_operations.append(operation)
            # 只保留最近 20 条操作
            if len(ctx.recent_operations) > 20:
                ctx.recent_operations = ctx.recent_operations[-20:]

    def add_message(self, session_id: str, role: str, content: str):
        """添加对话历史"""
        ctx = self.get_or_create(session_id)
        ctx.conversation_history.append({"role": role, "content": content})
        if len(ctx.conversation_history) > 50:
            ctx.conversation_history = ctx.conversation_history[-50:]

    def clear(self, session_id: str):
        """清除会话上下文"""
        self._sessions.pop(session_id, None)


# 全局单例
context_builder = ContextBuilder()
