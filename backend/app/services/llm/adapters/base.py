"""LLM 适配器基类"""
from abc import ABC, abstractmethod
from typing import AsyncGenerator
from app.services.llm.types import LLMRequest, LLMResponse, LLMConfig


class BaseAdapter(ABC):
    """LLM 适配器抽象基类"""

    provider: str = "base"

    def __init__(self, config: LLMConfig):
        self.config = config

    @abstractmethod
    async def chat(self, request: LLMRequest) -> LLMResponse:
        """同步对话"""
        ...

    @abstractmethod
    async def stream_chat(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        """流式对话，yield 文本片段"""
        ...

    def _build_messages(self, request: LLMRequest) -> list[dict]:
        """构建标准消息格式"""
        return [{"role": m.role, "content": m.content} for m in request.messages]
