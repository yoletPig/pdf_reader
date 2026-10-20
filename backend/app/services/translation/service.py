"""翻译服务入口"""
import hashlib
import logging
import re
import time
from typing import AsyncGenerator, Optional
from app.config import settings
from app.services.translation.types import TranslationRequest, TranslationResult, TranslationMode
from app.services.translation.terminology import terminology_engine
from app.services.translation.cache import translation_cache

logger = logging.getLogger(__name__)

MIN_TRUNCATION_CHECK_SOURCE_LENGTH = 800
MIN_OUTPUT_LENGTH_RATIO = 0.30
STRUCTURE_ALERT_RATIO = 0.45
RETRY_MAX_TOKENS = 6144
# 推理（thinking）模型会先消耗 reasoning_tokens 再输出正文，预算过小会导致正文为空/截断
# （实测 deepseek-v4-flash 在 max_tokens=4096 时 reasoning 就耗尽全部预算，content_len=0）。
# 翻译类任务输出较长，需要充足预算；16384 已实测可被 sensenova 端点接受。
MIN_TRANSLATION_MAX_TOKENS = 16384
TABLE_HEAVY_CHAR_RATIO = 0.35
MIN_PROSE_LENGTH_FOR_TABLE_HEAVY = 400
PREVIEW_CHARS = 180


class TranslationQualityError(RuntimeError):
    """翻译结果明显不完整。"""

    def __init__(
        self,
        message: str,
        *,
        source_length: int = 0,
        translated_length: int = 0,
        finish_reason: str = "",
        retry_count: int = 0,
        reason: str = "",
    ):
        super().__init__(message)
        self.source_length = source_length
        self.translated_length = translated_length
        self.finish_reason = finish_reason
        self.retry_count = retry_count
        self.reason = reason


def _is_markdown_table_line(line: str) -> bool:
    stripped = (line or "").strip()
    return bool(stripped) and stripped.startswith("|") and stripped.endswith("|")


def _comparable_source_length(source_text: str) -> tuple[int, list[str]]:
    source = (source_text or "").strip()
    if not source:
        return 0, []

    lines = source.splitlines()
    table_lines = [line for line in lines if _is_markdown_table_line(line)]
    table_chars = sum(len(line) for line in table_lines)
    prose_lines = [line for line in lines if not _is_markdown_table_line(line)]
    prose_text = "\n".join(prose_lines).strip()
    prose_len = len(prose_text)

    signals: list[str] = []
    total_len = len(source)
    if total_len > 0 and table_chars / total_len >= TABLE_HEAVY_CHAR_RATIO and prose_len >= MIN_PROSE_LENGTH_FOR_TABLE_HEAVY:
        signals.append(f"table_heavy_source={table_chars / total_len:.2f}")
        signals.append(f"prose_len={prose_len}")
        return prose_len, signals
    return total_len, signals


def _is_probably_truncated(source_text: str, translated_text: str) -> tuple[bool, str]:
    source = (source_text or "").strip()
    translated = (translated_text or "").strip()

    if len(source) < MIN_TRUNCATION_CHECK_SOURCE_LENGTH:
        return False, ""
    if not translated:
        return True, "empty_output"

    reasons: list[str] = []
    comparable_source_len, source_signals = _comparable_source_length(source)
    reasons.extend(source_signals)
    ratio = len(translated) / max(comparable_source_len, 1)
    if ratio < MIN_OUTPUT_LENGTH_RATIO:
        reasons.append(f"low_length_ratio={ratio:.2f}")

    source_heading_count = len(re.findall(r"(?m)^#{1,6}\s", source))
    translated_heading_count = len(re.findall(r"(?m)^#{1,6}\s", translated))
    if source_heading_count >= 2 and translated_heading_count < source_heading_count - 1:
        reasons.append("missing_headings")

    last_line = next((line.strip() for line in reversed(translated.splitlines()) if line.strip()), "")
    tail_is_reference_like = bool(
        re.search(r"(?:https?://|www\.)\S+\s*$", last_line)
        or re.search(r"(?:通讯作者|corresponding author)[。.]?\s*$", last_line, re.IGNORECASE)
        or re.search(r"(?:\[[0-9,\s-]+\]|\([0-9,\s-]+\))\s*$", last_line)
    )
    has_abrupt_ascii_tail = bool(re.search(r"[A-Za-z]{2,}\s*$", translated)) and not tail_is_reference_like
    has_unclosed_bracket_tail = bool(re.search(r"[\(\[\{（【][^\)\]\}）】]{0,40}$", translated))
    ends_cleanly = bool(re.search(r"(?:[。！？.!?：:]|\)|）)\s*$", translated))
    if (has_abrupt_ascii_tail or has_unclosed_bracket_tail) and not ends_cleanly:
        reasons.append("abrupt_tail")

    if ratio < MIN_OUTPUT_LENGTH_RATIO:
        return True, ",".join(reasons)
    if "abrupt_tail" in reasons and ratio < 0.60:
        return True, ",".join(reasons)
    if "missing_headings" in reasons and ratio < STRUCTURE_ALERT_RATIO:
        return True, ",".join(reasons)
    return False, ""


def _text_digest(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


def _text_preview(text: str, max_chars: int = PREVIEW_CHARS) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())[:max_chars]


def _translation_language_signals(text: str) -> dict[str, int | float]:
    value = text or ""
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", value))
    latin_words = len(re.findall(r"\b[A-Za-z]{3,}\b", value))
    total_chars = max(len(value.strip()), 1)
    return {
        "cjk_chars": cjk_chars,
        "latin_words": latin_words,
        "cjk_ratio": round(cjk_chars / total_chars, 3),
    }


def _looks_probably_untranslated(source_text: str, translated_text: str) -> tuple[bool, str]:
    source = source_text or ""
    translated = translated_text or ""
    if len(source.strip()) < 200 or len(translated.strip()) < 80:
        return False, ""

    signals = _translation_language_signals(translated)
    cjk_chars = int(signals["cjk_chars"])
    latin_words = int(signals["latin_words"])
    if cjk_chars < 30 and latin_words >= 40:
        return True, f"low_cjk_output cjk_chars={cjk_chars} latin_words={latin_words}"

    source_compact = re.sub(r"\s+", "", source)[:1200]
    translated_compact = re.sub(r"\s+", "", translated)[:1200]
    if len(source_compact) >= 400 and source_compact[:400] in translated_compact:
        return True, "output_contains_source_prefix"

    return False, ""


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
        cache_payload = "\n\n".join(
            part
            for part in [
                request.text,
                request.context,
                request.previous_summary,
                request.reference_pages,
                request.auxiliary_text,
            ]
            if part
        )
        logger.info(
            "翻译任务开始: paper_id=%s block_id=%s mode=%s source_len=%s context_len=%s previous_summary_len=%s reference_pages_len=%s auxiliary_text_len=%s skip_cache=%s cache_key_sha=%s source_sha=%s",
            request.paper_id,
            request.block_id,
            request.mode.value,
            len(request.text or ""),
            len(request.context or ""),
            len(request.previous_summary or ""),
            len(request.reference_pages or ""),
            len(request.auxiliary_text or ""),
            request.skip_cache,
            _text_digest(cache_payload),
            _text_digest(request.text or ""),
        )
        # 1. 检查缓存
        if not request.skip_cache:
            cached = translation_cache.get(
                request.paper_id, request.block_id,
                request.mode.value, cache_payload
            )
            if cached:
                logger.info(
                    "翻译缓存命中: paper_id=%s block_id=%s mode=%s cached_len=%s cached_sha=%s",
                    request.paper_id,
                    request.block_id,
                    request.mode.value,
                    len(cached or ""),
                    _text_digest(cached or ""),
                )
                return TranslationResult(
                    paper_id=request.paper_id,
                    block_id=request.block_id,
                    original_text=request.text,
                    translated_text=cached,
                    mode=request.mode,
                    from_cache=True,
                    source_text_length=len(request.text or ""),
                    translated_text_length=len(cached or ""),
                )

        # 2. 获取术语表
        terminology = terminology_engine.get_all_terms(request.paper_id)
        default_max_tokens = max(
            int(getattr(settings, "LLM_MAX_TOKENS", 4096) or 4096),
            MIN_TRANSLATION_MAX_TOKENS,
        )

        # 3. 调用 LLM 翻译（单次尝试：不做截断自动重试，是否重译由用户决定）
        started_at = time.perf_counter()
        try:
            translated_text = await self._translate_with_llm(
                text=request.text,
                mode=request.mode,
                context=request.context,
                previous_summary=request.previous_summary,
                reference_pages=request.reference_pages,
                auxiliary_text=request.auxiliary_text,
                terminology=terminology,
                max_tokens=default_max_tokens,
                retry_note="",
            )
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.exception(
                "翻译 LLM 调用异常: paper_id=%s block_id=%s elapsed_ms=%s error_type=%s error=%s",
                request.paper_id,
                request.block_id,
                elapsed_ms,
                type(exc).__name__,
                exc,
            )
            raise
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)

        translated_content = translated_text.content if hasattr(translated_text, "content") else translated_text
        finish_reason = translated_text.finish_reason if hasattr(translated_text, "finish_reason") else ""
        prompt_tokens = 0
        completion_tokens = 0
        if hasattr(translated_text, "usage") and isinstance(translated_text.usage, dict):
            prompt_tokens = int(translated_text.usage.get("prompt_tokens", 0) or 0)
            completion_tokens = int(translated_text.usage.get("completion_tokens", 0) or 0)

        # 仅记录质量信号，不再自动重试/拒绝——结果保留，是否重译由用户决定
        truncated, reason = _is_probably_truncated(request.text, translated_content)
        untranslated, untranslated_reason = _looks_probably_untranslated(request.text, translated_content)
        language_signals = _translation_language_signals(translated_content)
        logger.info(
            "翻译结果: paper_id=%s block_id=%s elapsed_ms=%s source_len=%s output_len=%s finish_reason=%s prompt_tokens=%s completion_tokens=%s total_tokens=%s skip_cache=%s output_sha=%s cjk_chars=%s latin_words=%s cjk_ratio=%s truncated=%s truncated_reason=%s untranslated=%s untranslated_reason=%s output_preview=%r",
            request.paper_id,
            request.block_id,
            elapsed_ms,
            len(request.text or ""),
            len(translated_content or ""),
            finish_reason or "unknown",
            prompt_tokens,
            completion_tokens,
            getattr(translated_text, "total_tokens", 0) if hasattr(translated_text, "total_tokens") else 0,
            request.skip_cache,
            _text_digest(translated_content or ""),
            language_signals["cjk_chars"],
            language_signals["latin_words"],
            language_signals["cjk_ratio"],
            truncated,
            reason,
            untranslated,
            untranslated_reason,
            _text_preview(translated_content or ""),
        )
        if truncated:
            logger.warning(
                "翻译结果疑似不完整（保留，等待用户判断是否重译）: paper_id=%s block_id=%s reason=%s",
                request.paper_id,
                request.block_id,
                reason,
            )

        if not request.skip_cache:
            translation_cache.set(
                request.paper_id, request.block_id,
                request.mode.value, cache_payload, translated_content
            )
            logger.info(
                "翻译写入内存缓存: paper_id=%s block_id=%s mode=%s cache_key_sha=%s output_sha=%s",
                request.paper_id,
                request.block_id,
                request.mode.value,
                _text_digest(cache_payload),
                _text_digest(translated_content or ""),
            )

        return TranslationResult(
            paper_id=request.paper_id,
            block_id=request.block_id,
            original_text=request.text,
            translated_text=translated_content,
            mode=request.mode,
            from_cache=False,
            model_used=translated_text.model if hasattr(translated_text, "model") else "",
            tokens_used=translated_text.total_tokens if hasattr(translated_text, "total_tokens") else 0,
            finish_reason=finish_reason or "",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            source_text_length=len(request.text or ""),
            translated_text_length=len(translated_content or ""),
            retry_count=0,
        )

    async def stream_translate_checked(self, request: TranslationRequest) -> AsyncGenerator[dict, None]:
        """带思考过程反馈的流式翻译（单次尝试，无自动重试；页翻译用）。

        事件:
          {"event": "thinking", "text": ...}            模型思考过程增量（前端"思考中"反馈）
          {"event": "delta",    "text": ...}            模型输出增量
          {"event": "result",   "result": TranslationResult}   最终结果（即使疑似截断也保留）
          {"event": "error",    "data": {...}}           调用失败
        """
        cache_payload = "\n\n".join(
            part
            for part in [
                request.text,
                request.context,
                request.previous_summary,
                request.reference_pages,
                request.auxiliary_text,
            ]
            if part
        )
        logger.info(
            "流式翻译任务开始: paper_id=%s block_id=%s mode=%s source_len=%s context_len=%s previous_summary_len=%s reference_pages_len=%s auxiliary_text_len=%s skip_cache=%s cache_key_sha=%s source_sha=%s",
            request.paper_id,
            request.block_id,
            request.mode.value,
            len(request.text or ""),
            len(request.context or ""),
            len(request.previous_summary or ""),
            len(request.reference_pages or ""),
            len(request.auxiliary_text or ""),
            request.skip_cache,
            _text_digest(cache_payload),
            _text_digest(request.text or ""),
        )

        if not request.skip_cache:
            cached = translation_cache.get(
                request.paper_id, request.block_id, request.mode.value, cache_payload
            )
            if cached:
                logger.info(
                    "流式翻译缓存命中: paper_id=%s block_id=%s mode=%s cached_len=%s",
                    request.paper_id,
                    request.block_id,
                    request.mode.value,
                    len(cached or ""),
                )
                yield {
                    "event": "result",
                    "result": TranslationResult(
                        paper_id=request.paper_id,
                        block_id=request.block_id,
                        original_text=request.text,
                        translated_text=cached,
                        mode=request.mode,
                        from_cache=True,
                        source_text_length=len(request.text or ""),
                        translated_text_length=len(cached or ""),
                    ),
                }
                return

        terminology = terminology_engine.get_all_terms(request.paper_id)
        default_max_tokens = max(
            int(getattr(settings, "LLM_MAX_TOKENS", 4096) or 4096),
            MIN_TRANSLATION_MAX_TOKENS,
        )

        started_at = time.perf_counter()
        parts: list[str] = []
        finish_reason = ""
        model_used = ""
        usage: dict = {}
        try:
            async for event in self._stream_translate_with_llm_meta(
                text=request.text,
                mode=request.mode,
                context=request.context,
                previous_summary=request.previous_summary,
                reference_pages=request.reference_pages,
                auxiliary_text=request.auxiliary_text,
                terminology=terminology,
                max_tokens=default_max_tokens,
                retry_note="",
            ):
                if event.get("type") == "thinking":
                    yield {"event": "thinking", "text": event.get("text", "")}
                elif event.get("type") == "delta":
                    chunk_text = event.get("text", "")
                    parts.append(chunk_text)
                    yield {"event": "delta", "text": chunk_text}
                elif event.get("type") == "done":
                    finish_reason = event.get("finish_reason", "") or ""
                    model_used = event.get("model", "") or ""
                    usage = event.get("usage") or {}
        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            logger.exception(
                "流式翻译 LLM 调用异常: paper_id=%s block_id=%s elapsed_ms=%s error_type=%s error=%s",
                request.paper_id,
                request.block_id,
                elapsed_ms,
                type(exc).__name__,
                exc,
            )
            raise

        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        translated_content = "".join(parts)
        prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
        completion_tokens = int(usage.get("completion_tokens", 0) or 0)

        # 仅记录质量信号，不再自动重试/拒绝——结果保留，是否重译由用户决定
        truncated, reason = _is_probably_truncated(request.text, translated_content)
        untranslated, untranslated_reason = _looks_probably_untranslated(request.text, translated_content)
        language_signals = _translation_language_signals(translated_content)
        logger.info(
            "流式翻译结果: paper_id=%s block_id=%s elapsed_ms=%s source_len=%s output_len=%s finish_reason=%s prompt_tokens=%s completion_tokens=%s skip_cache=%s output_sha=%s cjk_chars=%s latin_words=%s cjk_ratio=%s truncated=%s truncated_reason=%s untranslated=%s untranslated_reason=%s output_preview=%r",
            request.paper_id,
            request.block_id,
            elapsed_ms,
            len(request.text or ""),
            len(translated_content or ""),
            finish_reason or "unknown",
            prompt_tokens,
            completion_tokens,
            request.skip_cache,
            _text_digest(translated_content or ""),
            language_signals["cjk_chars"],
            language_signals["latin_words"],
            language_signals["cjk_ratio"],
            truncated,
            reason,
            untranslated,
            untranslated_reason,
            _text_preview(translated_content or ""),
        )
        if truncated:
            logger.warning(
                "流式翻译结果疑似不完整（保留，等待用户判断是否重译）: paper_id=%s block_id=%s reason=%s",
                request.paper_id,
                request.block_id,
                reason,
            )

        if not request.skip_cache:
            translation_cache.set(
                request.paper_id, request.block_id,
                request.mode.value, cache_payload, translated_content
            )
            logger.info(
                "流式翻译写入内存缓存: paper_id=%s block_id=%s mode=%s cache_key_sha=%s output_sha=%s",
                request.paper_id,
                request.block_id,
                request.mode.value,
                _text_digest(cache_payload),
                _text_digest(translated_content or ""),
            )

        yield {
            "event": "result",
            "result": TranslationResult(
                paper_id=request.paper_id,
                block_id=request.block_id,
                original_text=request.text,
                translated_text=translated_content,
                mode=request.mode,
                from_cache=False,
                model_used=model_used,
                tokens_used=int(usage.get("total_tokens", 0) or 0),
                finish_reason=finish_reason or "",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                source_text_length=len(request.text or ""),
                translated_text_length=len(translated_content or ""),
                retry_count=0,
            ),
        }

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
            previous_summary=request.previous_summary,
            reference_pages=request.reference_pages,
            auxiliary_text=request.auxiliary_text,
            terminology=terminology,
        ):
            yield chunk

    async def _translate_with_llm(
        self,
        text: str,
        mode: TranslationMode,
        context: str = "",
        previous_summary: str = "",
        reference_pages: str = "",
        auxiliary_text: str = "",
        terminology: dict[str, str] = {},
        max_tokens: int = 4096,
        retry_note: str = "",
    ) -> str:
        """调用 LLM 进行翻译"""
        if not self._llm_router:
            logger.warning("LLM 路由器未配置，返回占位文本")
            return f"[LLM 未配置] {text}"

        from app.services.llm.types import LLMRequest

        llm_messages = self._build_llm_messages(
            text=text,
            context=context,
            previous_summary=previous_summary,
            reference_pages=reference_pages,
            auxiliary_text=auxiliary_text,
            terminology=terminology,
            retry_note=retry_note,
        )

        llm_request = LLMRequest(messages=llm_messages, temperature=0.3, max_tokens=max_tokens)
        logger.info("调用 LLM 默认模型")
        response = await self._llm_router.chat(llm_request)
        logger.info(
            "LLM 响应成功: model=%s tokens=%s finish_reason=%s content_len=%s content_sha=%s content_preview=%r",
            response.model,
            response.total_tokens,
            response.finish_reason,
            len(response.content),
            _text_digest(response.content or ""),
            _text_preview(response.content or ""),
        )
        return response

    def _build_llm_messages(
        self,
        *,
        text: str,
        context: str = "",
        previous_summary: str = "",
        reference_pages: str = "",
        auxiliary_text: str = "",
        terminology: dict[str, str] | None = None,
        retry_note: str = "",
    ) -> list:
        """构建翻译 Prompt 消息列表（统一 polish_translate 提示词）。"""
        from app.services.llm.types import LLMMessage
        from app.services.prompt.manager import prompt_manager

        # 已取消快速/严谨双模式区分：统一使用高质量翻译提示词
        prompt_mode = "polish_translate"
        logger.info(
            "构建 Prompt: mode=%s text_len=%s context_len=%s previous_summary_len=%s reference_pages_len=%s auxiliary_text_len=%s retry_note=%s",
            prompt_mode,
            len(text),
            len(context or ""),
            len(previous_summary or ""),
            len(reference_pages or ""),
            len(auxiliary_text or ""),
            bool(retry_note),
        )

        effective_context = context
        if retry_note:
            effective_context = "\n".join(part for part in [context.strip(), retry_note.strip()] if part)

        messages = prompt_manager.build_prompt(
            mode=prompt_mode,
            task="translate_paragraph" if len(text) > 200 else "translate_sentence",
            variables={
                "text": text,
                "context": effective_context,
                "previous_summary": previous_summary,
                "reference_pages": reference_pages,
                "auxiliary_text": auxiliary_text,
            },
            terminology=terminology or {},
        )
        logger.info(
            "Prompt 构建完成: mode=%s message_count=%s message_lens=%s total_prompt_chars=%s text_sha=%s auxiliary_sha=%s reference_sha=%s",
            prompt_mode,
            len(messages),
            [len(m.content or "") for m in messages],
            sum(len(m.content or "") for m in messages),
            _text_digest(text or ""),
            _text_digest(auxiliary_text or ""),
            _text_digest(reference_pages or ""),
        )
        return [LLMMessage(role=m.role, content=m.content) for m in messages]

    async def _stream_translate_with_llm(
        self,
        text: str,
        mode: TranslationMode,
        context: str = "",
        previous_summary: str = "",
        reference_pages: str = "",
        auxiliary_text: str = "",
        terminology: dict[str, str] = {},
    ) -> AsyncGenerator[str, None]:
        """流式调用 LLM（纯文本增量）"""
        async for event in self._stream_translate_with_llm_meta(
            text=text,
            mode=mode,
            context=context,
            previous_summary=previous_summary,
            reference_pages=reference_pages,
            auxiliary_text=auxiliary_text,
            terminology=terminology,
        ):
            if event.get("type") == "delta":
                yield event.get("text", "")

    async def _stream_translate_with_llm_meta(
        self,
        text: str,
        mode: TranslationMode,
        context: str = "",
        previous_summary: str = "",
        reference_pages: str = "",
        auxiliary_text: str = "",
        terminology: dict[str, str] = {},
        max_tokens: int = 4096,
        retry_note: str = "",
    ) -> AsyncGenerator[dict, None]:
        """流式调用 LLM（带 finish_reason/usage 元数据）"""
        if not self._llm_router:
            yield {"type": "delta", "text": f"[LLM 未配置] {text}"}
            yield {"type": "done", "model": "", "finish_reason": "", "usage": {}}
            return

        from app.services.llm.types import LLMRequest

        llm_messages = self._build_llm_messages(
            text=text,
            context=context,
            previous_summary=previous_summary,
            reference_pages=reference_pages,
            auxiliary_text=auxiliary_text,
            terminology=terminology,
            retry_note=retry_note,
        )

        llm_request = LLMRequest(messages=llm_messages, temperature=0.3, max_tokens=max_tokens, stream=True)
        async for event in self._llm_router.stream_chat_with_meta(llm_request):
            yield event

    def get_cached_for_paper(self, paper_id: str) -> list[dict]:
        """获取论文的翻译缓存"""
        return translation_cache.get_by_paper(paper_id)


# 全局单例
translation_service = TranslationService()
