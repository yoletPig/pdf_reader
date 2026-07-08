"""意图类型枚举与定义"""
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional


class IntentType(str, Enum):
    QUICK_TRANSLATE = "quick_translate"
    POLISH_TRANSLATE = "polish_translate"
    BATCH_TRANSLATE = "batch_translate"
    TERM_EXPLAIN = "term_explain"
    PARAGRAPH_EXPLAIN = "paragraph_explain"
    FORMULA_EXPLAIN = "formula_explain"
    SINGLE_PAPER_QA = "single_paper_qa"
    CROSS_PAPER_QA = "cross_paper_qa"
    METHOD_COMPARE = "method_compare"
    PAPER_SEARCH = "paper_search"
    SIMILAR_RECOMMEND = "similar_recommend"
    NOTE_MANAGE = "note_manage"
    KB_MANAGE = "kb_manage"


@dataclass
class SessionContext:
    """会话上下文"""
    current_paper_id: Optional[str] = None
    current_page: int = 0
    recent_operations: list[str] = field(default_factory=list)
    selected_text: Optional[str] = None
    selected_block_id: Optional[str] = None
    conversation_history: list[dict] = field(default_factory=list)


@dataclass
class IntentResult:
    """意图识别结果"""
    intent: IntentType
    confidence: float
    params: dict = field(default_factory=dict)  # 提取的参数 (文本、论文ID等)
    context: SessionContext = field(default_factory=SessionContext)
    suggested_agent: str = ""  # 建议的 Agent 模式
