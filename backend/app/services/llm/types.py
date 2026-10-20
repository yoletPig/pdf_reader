"""LLM 相关类型定义"""
from dataclasses import dataclass, field
from typing import Optional, AsyncGenerator


@dataclass
class LLMMessage:
    """统一消息格式"""
    role: str  # system / user / assistant
    content: str


@dataclass
class LLMRequest:
    """统一请求格式"""
    messages: list[LLMMessage]
    model: str = ""
    max_tokens: int = 4096
    temperature: float = 0.3
    top_p: float = 1.0
    stream: bool = False
    stop: Optional[list[str]] = None

    @classmethod
    def from_messages(
        cls,
        messages: list[dict],
        model: str = "",
        max_tokens: int = 4096,
        temperature: float = 0.3,
        stream: bool = False,
    ) -> "LLMRequest":
        return cls(
            messages=[LLMMessage(role=m["role"], content=m["content"]) for m in messages],
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=stream,
        )


@dataclass
class LLMResponse:
    """统一响应格式"""
    content: str
    model: str = ""
    usage: dict = field(default_factory=dict)  # {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    finish_reason: str = "stop"

    @property
    def total_tokens(self) -> int:
        return self.usage.get("total_tokens", 0)


@dataclass
class LLMConfig:
    """模型配置"""
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 4096
    temperature: float = 0.3
    trust_env: bool = False
    # 推理模型思考程度：default(不传参)/none/low/medium/high/xhigh
    reasoning_effort: str = "default"
    # 单次 LLM 请求超时（秒）。长页翻译 + 代理链路可能耗时较久（实测 ~85s），
    # 默认 300s 避免误杀；可在 .env 用 PDF_READER_LLM_TIMEOUT 覆盖。
    timeout_seconds: float = 300.0
