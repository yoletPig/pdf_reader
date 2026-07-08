"""Agent 基类"""
from abc import ABC, abstractmethod
from typing import AsyncGenerator, Optional
from dataclasses import dataclass, field
from app.services.prompt.manager import ChatMessage


@dataclass
class AgentRequest:
    """Agent 请求"""
    intent: str
    params: dict = field(default_factory=dict)
    paper_id: Optional[str] = None
    session_id: str = "default"


@dataclass
class AgentResponse:
    """Agent 响应"""
    content: str
    agent_name: str = ""
    sources: list[dict] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


class BaseAgent(ABC):
    """Agent 抽象基类"""

    name: str = "base"
    description: str = ""
    prompt_mode: str = ""  # 绑定的 Prompt 模式

    @abstractmethod
    async def execute(self, request: AgentRequest) -> AgentResponse:
        """执行 Agent 任务"""
        ...

    async def stream_execute(self, request: AgentRequest) -> AsyncGenerator[str, None]:
        """流式执行 Agent 任务，默认实现为 yield 完整结果"""
        response = await self.execute(request)
        yield response.content
