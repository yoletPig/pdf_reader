"""意图识别主引擎"""
from typing import Optional
from app.services.intent.intent_types import IntentType, IntentResult, SessionContext
from app.services.intent.classifier import IntentClassifier
from app.services.intent.context import ContextBuilder
from app.services.intent.router import get_agent_for_intent


class IntentEngine:
    """意图识别引擎 - 多模态意图分类 + 上下文感知 + 意图路由"""

    def __init__(self):
        self.classifier = IntentClassifier()
        self.context_builder = ContextBuilder()

    async def recognize(
        self,
        user_input: str,
        context: SessionContext,
        selected_text: Optional[str] = None,
        current_paper_id: Optional[str] = None,
    ) -> IntentResult:
        """
        识别用户意图。

        Args:
            user_input: 用户输入文本
            context: 会话上下文
            selected_text: 用户选中的文本
            current_paper_id: 当前阅读的论文 ID

        Returns:
            IntentResult: 意图识别结果
        """
        # 更新上下文
        if current_paper_id:
            context.current_paper_id = current_paper_id
        if selected_text:
            context.selected_text = selected_text

        # 1. 规则分类器快速识别
        result = self.classifier.classify(
            user_input=user_input,
            context=context,
            selected_text=selected_text,
        )

        if result:
            intent, confidence = result
        else:
            # 2. 规则无法识别时，需要 LLM 分类
            # 注意：这里返回一个默认意图，实际 LLM 分类在 Agent 编排器中处理
            intent, confidence = self._llm_classify(
                user_input=user_input,
                context=context,
                selected_text=selected_text,
            )

        # 构建参数
        params = self._extract_params(
            intent=intent,
            user_input=user_input,
            selected_text=selected_text,
            paper_id=current_paper_id,
        )

        return IntentResult(
            intent=intent,
            confidence=confidence,
            params=params,
            context=context,
            suggested_agent=get_agent_for_intent(intent),
        )

    def _llm_classify(
        self,
        user_input: str,
        context: SessionContext,
        selected_text: Optional[str] = None,
    ) -> tuple[IntentType, float]:
        """
        LLM 分类器（简化版，生产环境应调用 LLM）。
        当前使用启发式规则作为兜底。
        """
        # 如果有选中文本 → 默认快速翻译
        if selected_text and len(selected_text.strip()) > 0:
            if len(selected_text.split()) > 20:
                return (IntentType.POLISH_TRANSLATE, 0.6)
            elif len(selected_text.split()) <= 3:
                return (IntentType.QUICK_TRANSLATE, 0.65)
            else:
                return (IntentType.PARAGRAPH_EXPLAIN, 0.55)

        # 有输入文本 → 默认跨论文问答
        if user_input and len(user_input.strip()) > 5:
            return (IntentType.CROSS_PAPER_QA, 0.5)

        # 完全无法判断
        return (IntentType.CROSS_PAPER_QA, 0.3)

    def _extract_params(
        self,
        intent: IntentType,
        user_input: str,
        selected_text: Optional[str] = None,
        paper_id: Optional[str] = None,
    ) -> dict:
        """从输入中提取参数"""
        params: dict = {}

        if selected_text:
            params["text"] = selected_text

        if paper_id:
            params["paper_id"] = paper_id

        # 根据意图类型设置参数
        if intent in (IntentType.QUICK_TRANSLATE, IntentType.POLISH_TRANSLATE):
            params["mode"] = "quick" if intent == IntentType.QUICK_TRANSLATE else "polish"
        elif intent in (IntentType.TERM_EXPLAIN, IntentType.PARAGRAPH_EXPLAIN):
            params["explain_type"] = "term" if intent == IntentType.TERM_EXPLAIN else "paragraph"
        elif intent == IntentType.CROSS_PAPER_QA:
            params["question"] = user_input

        return params
