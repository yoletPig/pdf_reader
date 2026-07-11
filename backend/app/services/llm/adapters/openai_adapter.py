"""OpenAI 适配器"""
import logging
from typing import AsyncGenerator

import httpx

from app.services.llm.adapters.base import BaseAdapter
from app.services.llm.types import LLMRequest, LLMResponse, LLMConfig

logger = logging.getLogger(__name__)


class OpenAIAdapter(BaseAdapter):
    provider = "openai"

    def __init__(self, config: LLMConfig):
        super().__init__(config)
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise RuntimeError("缺少 openai 依赖，请先安装 openai 包") from exc

        try:
            http_client = httpx.AsyncClient(
                base_url=config.base_url or "https://api.openai.com/v1",
                timeout=120.0,
                trust_env=config.trust_env,
            )
        except ImportError as exc:
            raise RuntimeError(
                "当前环境启用了 SOCKS 代理，但缺少 socksio 依赖。请安装 `httpx[socks]` 或 `socksio`。"
            ) from exc
        self.client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url or "https://api.openai.com/v1",
            timeout=120.0,
            http_client=http_client,
        )

    async def chat(self, request: LLMRequest) -> LLMResponse:
        model = request.model or self.config.model
        logger.info(
            f"OpenAI chat 请求: model={model}, base_url={self.config.base_url}, "
            f"msg_count={len(request.messages)}"
        )
        response = await self.client.chat.completions.create(
            model=model,
            messages=self._build_messages(request),
            max_tokens=request.max_tokens or self.config.max_tokens,
            temperature=request.temperature if request.temperature is not None else self.config.temperature,
            top_p=request.top_p,
            stop=request.stop,
            stream=False,
        )
        choice = response.choices[0]
        return LLMResponse(
            content=choice.message.content or "",
            model=response.model or model,
            usage=(response.usage.model_dump() if response.usage else {}),
            finish_reason=choice.finish_reason or "stop",
        )

    async def stream_chat(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        model = request.model or self.config.model
        stream = await self.client.chat.completions.create(
            model=model,
            messages=self._build_messages(request),
            max_tokens=request.max_tokens or self.config.max_tokens,
            temperature=request.temperature if request.temperature is not None else self.config.temperature,
            top_p=request.top_p,
            stop=request.stop,
            stream=True,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            content = chunk.choices[0].delta.content or ""
            if content:
                yield content

    async def close(self):
        await self.client.close()
