"""规则 + 关键词分类器，快速识别用户意图"""
from typing import Optional
from app.services.intent.intent_types import IntentType, SessionContext


class IntentClassifier:
    """基于规则和关键词的意图快速分类器"""

    # 关键词 → 意图映射
    KEYWORD_RULES: dict[str, list[tuple[list[str], IntentType, float]]] = {
        "translate": [
            (["翻译", "translate", "译", "翻一下"], IntentType.QUICK_TRANSLATE, 0.9),
            (["精翻", "润色", "严谨", "polish", "学术翻译"], IntentType.POLISH_TRANSLATE, 0.9),
            (["全文翻译", "批量翻译", "翻译全文", "translate all"], IntentType.BATCH_TRANSLATE, 0.85),
        ],
        "explain": [
            (["解释", "说明", "什么是", "explain", "什么意思", "含义"], IntentType.TERM_EXPLAIN, 0.8),
            (["这段", "这一段", "解读", "这段什么意思", "解释这段"], IntentType.PARAGRAPH_EXPLAIN, 0.85),
            (["公式", "formula", "推导", "这个公式"], IntentType.FORMULA_EXPLAIN, 0.85),
        ],
        "qa": [
            (["对比", "比较", "compare", "区别", "不同"], IntentType.METHOD_COMPARE, 0.85),
            (["这篇", "这个论文", "本文", "这篇文章", "当前论文"], IntentType.SINGLE_PAPER_QA, 0.75),
            (["跨论文", "所有论文", "全部", "总体", "综述", "汇总"], IntentType.CROSS_PAPER_QA, 0.8),
        ],
        "search": [
            (["搜索", "检索", "查找", "search", "找论文", "找文献"], IntentType.PAPER_SEARCH, 0.9),
            (["推荐", "相关论文", "相似", "推荐论文", "类似"], IntentType.SIMILAR_RECOMMEND, 0.85),
        ],
        "manage": [
            (["笔记", "note", "标注", "高亮"], IntentType.NOTE_MANAGE, 0.85),
            (["知识库", "管理", "标签", "分类", "整理"], IntentType.KB_MANAGE, 0.8),
        ],
    }

    # 操作触发映射：纯选中文本 → 意图
    SELECTION_TRIGGERS: list[tuple[callable, IntentType, float]] = [
        # 选中短文本（1-3词）→ 快速翻译
        (lambda text: 1 <= len(text.split()) <= 3 and len(text) < 80, IntentType.QUICK_TRANSLATE, 0.85),
        # 选中中等文本（4-20词）→ 段落解释
        (lambda text: 4 <= len(text.split()) <= 20 and len(text) < 300, IntentType.PARAGRAPH_EXPLAIN, 0.7),
        # 选中长文本（>20词）→ 严谨翻译
        (lambda text: len(text.split()) > 20, IntentType.POLISH_TRANSLATE, 0.75),
    ]

    def classify(
        self,
        user_input: str,
        context: SessionContext,
        selected_text: Optional[str] = None,
    ) -> Optional[tuple[IntentType, float]]:
        """
        快速分类用户意图。
        返回 (意图类型, 置信度) 或 None（表示需要 LLM 分类）。
        """

        # 1. 如果有选中文本但没有明确输入 → 基于选中文本长度判断
        if selected_text and (not user_input or len(user_input.strip()) < 3):
            for condition, intent, confidence in self.SELECTION_TRIGGERS:
                if condition(selected_text.strip()):
                    return (intent, confidence)

        # 2. 如果有明确输入 → 关键词匹配
        if user_input and len(user_input.strip()) >= 1:
            text = user_input.lower().strip()

            # 检查是否只是按钮点击触发的简单指令
            simple_commands = {
                "快速翻译": IntentType.QUICK_TRANSLATE,
                "严谨润色": IntentType.POLISH_TRANSLATE,
                "解释": IntentType.TERM_EXPLAIN,
                "问答": IntentType.CROSS_PAPER_QA,
                "搜索": IntentType.PAPER_SEARCH,
            }

            if text in simple_commands:
                return (simple_commands[text], 0.95)

            # 关键词匹配
            best_match: Optional[tuple[IntentType, float]] = None
            best_score = 0.0

            for category, rules in self.KEYWORD_RULES.items():
                for keywords, intent, base_confidence in rules:
                    matches = sum(1 for kw in keywords if kw.lower() in text)
                    if matches > 0:
                        # 匹配的关键词越多，置信度越高
                        score = base_confidence + (matches - 1) * 0.05
                        score = min(score, 0.99)
                        if score > best_score:
                            best_score = score
                            best_match = (intent, score)

            if best_match and best_match[1] >= 0.8:
                return best_match

        # 3. 需要 LLM 进行更精确的分类
        return None
