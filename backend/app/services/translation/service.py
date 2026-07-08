"""翻译服务入口"""
import logging
from typing import AsyncGenerator, Optional
from app.services.translation.types import TranslationRequest, TranslationResult, TranslationMode
from app.services.translation.terminology import terminology_engine
from app.services.translation.cache import translation_cache

logger = logging.getLogger(__name__)


class TranslationService:
    """翻译服务 - 段落/句子/全文翻译 + 缓存 + 术语一致性"""

    def __init__(self, llm_router=None):
        self._llm_router = llm_router
        self._paragraph_translator = None
        self._sentence_translator = None
        self._batch_translator = None

    def set_llm_router(self, router):
        """注入 LLM 路由器"""
        self._llm_router = router

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        """翻译段落/句子"""
        # 1. 检查缓存
        cached = translation_cache.get(
            request.paper_id, request.block_id,
            request.mode.value, request.text
        )
        if cached:
            return TranslationResult(
                paper_id=request.paper_id,
                block_id=request.block_id,
                original_text=request.text,
                translated_text=cached,
                mode=request.mode,
                from_cache=True,
            )

        # 2. 获取术语表
        terminology = terminology_engine.get_all_terms(request.paper_id)

        # 3. 调用 LLM 翻译
        translated_text = await self._translate_with_llm(
            text=request.text,
            mode=request.mode,
            context=request.context,
            terminology=terminology,
        )

        # 4. 存入缓存
        translated_content = translated_text.content if hasattr(translated_text, 'content') else translated_text
        translation_cache.set(
            request.paper_id, request.block_id,
            request.mode.value, request.text, translated_content
        )

        return TranslationResult(
            paper_id=request.paper_id,
            block_id=request.block_id,
            original_text=request.text,
            translated_text=translated_content,
            mode=request.mode,
            from_cache=False,
            model_used=translated_text.model if hasattr(translated_text, 'model') else "",
            tokens_used=translated_text.total_tokens if hasattr(translated_text, 'total_tokens') else 0,
        )

    async def stream_translate(
        self, request: TranslationRequest
    ) -> AsyncGenerator[str, None]:
        """流式翻译"""
        # 获取术语表
        terminology = terminology_engine.get_all_terms(request.paper_id)

        # 流式调用 LLM
        async for chunk in self._stream_translate_with_llm(
            text=request.text,
            mode=request.mode,
            context=request.context,
            terminology=terminology,
        ):
            yield chunk

    async def _translate_with_llm(
        self,
        text: str,
        mode: TranslationMode,
        context: str = "",
        terminology: dict[str, str] = {},
    ) -> str:
        """调用 LLM 进行翻译"""
        if not self._llm_router:
            logger.warning("LLM 路由器未配置，返回占位文本")
            return f"[LLM 未配置] {text}"

        from app.services.llm.types import LLMRequest, LLMMessage
        from app.services.prompt.manager import prompt_manager

        prompt_mode = "quick_translate" if mode == TranslationMode.QUICK else "polish_translate"
        logger.info(f"构建 Prompt: mode={prompt_mode}, text_len={len(text)}")

        messages = prompt_manager.build_prompt(
            mode=prompt_mode,
            task="translate_paragraph" if len(text) > 200 else "translate_sentence",
            variables={"text": text, "context": context},
            terminology=terminology,
        )
        logger.debug(f"Prompt 消息数: {len(messages)}")

        llm_messages = [
            LLMMessage(role=m.role, content=m.content) for m in messages
        ]

        llm_request = LLMRequest(messages=llm_messages, temperature=0.3, max_tokens=4096)
        logger.info("调用 LLM 默认模型")
        response = await self._llm_router.chat(llm_request)
        logger.info(f"LLM 响应成功: model={response.model}, tokens={response.total_tokens}, "
                     f"content_len={len(response.content)}")
        return response

    async def _stream_translate_with_llm(
        self,
        text: str,
        mode: TranslationMode,
        context: str = "",
        terminology: dict[str, str] = {},
    ) -> AsyncGenerator[str, None]:
        """流式调用 LLM"""
        if not self._llm_router:
            yield f"[LLM 未配置] {text}"
            return

        from app.services.llm.types import LLMRequest, LLMMessage
        from app.services.prompt.manager import prompt_manager

        prompt_mode = "quick_translate" if mode == TranslationMode.QUICK else "polish_translate"
        messages = prompt_manager.build_prompt(
            mode=prompt_mode,
            task="translate_paragraph" if len(text) > 200 else "translate_sentence",
            variables={"text": text, "context": context},
            terminology=terminology,
        )

        llm_messages = [
            LLMMessage(role=m.role, content=m.content) for m in messages
        ]

        llm_request = LLMRequest(messages=llm_messages, temperature=0.3, max_tokens=4096, stream=True)
        async for chunk in self._llm_router.stream_chat(llm_request):
            yield chunk

    def get_cached_for_paper(self, paper_id: str) -> list[dict]:
        """获取论文的翻译缓存"""
        return translation_cache.get_by_paper(paper_id)


# 全局单例
translation_service = TranslationService()
