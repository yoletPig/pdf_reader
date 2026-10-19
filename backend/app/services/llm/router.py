"""大模型路由器"""
import logging
from typing import AsyncGenerator

from app.config import settings
from app.services.llm.adapters.openai_adapter import OpenAIAdapter
from app.services.llm.types import LLMRequest, LLMResponse, LLMConfig

logger = logging.getLogger(__name__)


class LLMRouter:
    """单模型路由器 - 统一异步接口"""

    def __init__(self):
        self._adapter: OpenAIAdapter | None = None
        self._config: LLMConfig | None = None

    async def reload_from_settings(self):
        """从环境变量重载单模型配置。"""
        await self.close_all()

        self._config = LLMConfig(
            api_key=settings.LLM_API_KEY,
            base_url=settings.LLM_BASE_URL,
            model=settings.LLM_MODEL,
            max_tokens=settings.LLM_MAX_TOKENS,
            temperature=settings.LLM_TEMPERATURE,
            trust_env=settings.LLM_TRUST_ENV,
            timeout_seconds=settings.LLM_TIMEOUT,
        )
        self._adapter = OpenAIAdapter(self._config)
        logger.info(
            "注册单模型适配器: model=%s base_url=%s api_key=%s",
            self._config.model,
            self._config.base_url,
            "已配置" if self._config.api_key else "❌ 未配置",
        )

    async def apply_config(self, config: LLMConfig):
        """应用运行时配置（来自系统设置页），并热替换适配器。"""
        await self.close_all()
        self._config = config
        self._adapter = OpenAIAdapter(config)
        logger.info(
            "应用运行时模型配置: model=%s base_url=%s api_key=%s",
            config.model,
            config.base_url,
            "已配置" if config.api_key else "❌ 未配置",
        )

    def _get_adapter(self) -> OpenAIAdapter:
        if self._adapter is None:
            logger.error("LLM 适配器未初始化，请检查 .env 配置。")
            raise ValueError("LLM 适配器未初始化，请检查 .env 配置")
        return self._adapter

    async def chat(
        self,
        request: LLMRequest,
        model: str = "",
    ) -> LLMResponse:
        """同步对话"""
        try:
            adapter = self._get_adapter()
            logger.info("调用 adapter.chat: model=%s", model or adapter.config.model)
            if model:
                request.model = model
            return await adapter.chat(request)
        except Exception as e:
            logger.error("LLM chat 失败: model=%s, error=%s", model or "default", e)
            import traceback
            traceback.print_exc()
            raise

    async def stream_chat(
        self,
        request: LLMRequest,
        model: str = "",
    ) -> AsyncGenerator[str, None]:
        """流式对话"""
        adapter = self._get_adapter()
        if model:
            request.model = model
        async for chunk in adapter.stream_chat(request):
            yield chunk

    async def close_all(self):
        """关闭所有适配器的连接"""
        if self._adapter is not None:
            await self._adapter.close()
        self._adapter = None


# 全局单例
llm_router = LLMRouter()
