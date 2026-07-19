"""OpenAI 适配器"""
import logging
import time
from typing import AsyncGenerator

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError

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
        max_tokens = request.max_tokens or self.config.max_tokens
        temperature = request.temperature if request.temperature is not None else self.config.temperature
        message_lengths = [len(message.content or "") for message in request.messages]
        logger.info(
            "OpenAI chat 请求: model=%s base_url=%s msg_count=%s msg_lens=%s max_tokens=%s temperature=%s top_p=%s stop_set=%s trust_env=%s",
            model,
            self.config.base_url,
            len(request.messages),
            message_lengths,
            max_tokens,
            temperature,
            request.top_p,
            bool(request.stop),
            self.config.trust_env,
        )
        started_at = time.perf_counter()
        try:
            response = await self.client.chat.completions.create(
                model=model,
                messages=self._build_messages(request),
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=request.top_p,
                stop=request.stop,
                stream=False,
            )
        except APIStatusError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            response_text = getattr(exc.response, "text", "") if getattr(exc, "response", None) else ""
            logger.exception(
                "OpenAI chat HTTP 错误: model=%s status_code=%s request_id=%s elapsed_ms=%s response_preview=%r",
                model,
                exc.status_code,
                getattr(exc, "request_id", ""),
                elapsed_ms,
                (response_text or "")[:500],
            )
            raise
        except APITimeoutError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.exception("OpenAI chat 超时: model=%s elapsed_ms=%s error=%s", model, elapsed_ms, exc)
            raise
        except APIConnectionError as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.exception("OpenAI chat 连接错误: model=%s elapsed_ms=%s error=%s", model, elapsed_ms, exc)
            raise
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.exception("OpenAI chat 未知异常: model=%s elapsed_ms=%s error_type=%s error=%s", model, elapsed_ms, type(exc).__name__, exc)
            raise
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        choice = response.choices[0]
        usage = response.usage.model_dump() if response.usage else {}
        logger.info(
            "OpenAI chat 响应: id=%s model=%s elapsed_ms=%s choice_count=%s finish_reason=%s usage=%s content_len=%s system_fingerprint=%s",
            getattr(response, "id", ""),
            response.model or model,
            elapsed_ms,
            len(response.choices or []),
            choice.finish_reason or "",
            usage,
            len(choice.message.content or ""),
            getattr(response, "system_fingerprint", ""),
        )
        return LLMResponse(
            content=choice.message.content or "",
            model=response.model or model,
            usage=usage,
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
