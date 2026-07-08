"""意图识别服务 - 分析用户输入，识别意图类型和参数"""
from enum import Enum
from typing import Optional
from dataclasses import dataclass, field


class IntentType(str, Enum):
    """意图类型"""
    TRANSLATE = "translate"           # 翻译
    EXPLAIN = "explain"               # 解释概念/术语
    SUMMARIZE = "summarize"           # 总结
    SEARCH = "search"                 # 搜索论文
    QA = "qa"                         # 问答
    COMPARE = "compare"               # 对比
    ANALYZE = "analyze"               # 分析（方法/结果）
    FIND_METHOD = "find_method"       # 查找方法
    FIND_RESULT = "find_result"       # 查找结果
    FIND_RELATED = "find_related"     # 查找相关工作
    CHAT = "chat"                     # 闲聊
    UNKNOWN = "unknown"               # 未知


@dataclass
class IntentResult:
    """意图识别结果"""
    intent: IntentType
    confidence: float = 1.0
    entities: dict[str, str] = field(default_factory=dict)  # 提取的实体
    params: dict = field(default_factory=dict)  # 额外参数
    raw_query: str = ""


class IntentRecognizer:
    """基于规则的意图识别器"""

    # 意图关键词映射
    INTENT_PATTERNS: dict[IntentType, list[str]] = {
        IntentType.TRANSLATE: [
            "翻译", "translate", "译成", "翻成", "用中文", "中文翻译",
            "翻一下", "译一下", "翻成中文",
        ],
        IntentType.EXPLAIN: [
            "解释", "explain", "是什么", "什么是", "什么意思", "定义",
            "概念", "阐述", "说明一下", "讲一下", "介绍一下",
            "what is", "what does", "define", "definition",
        ],
        IntentType.SUMMARIZE: [
            "总结", "summarize", "summary", "概括", "归纳", "摘要",
            "概述", "大意", "要点", "核心内容", "这篇论文讲了什么",
            "sum up", "tl;dr", "tldr",
        ],
        IntentType.SEARCH: [
            "搜索", "search", "找论文", "查找", "检索", "找一下",
            "有没有", "推荐", "论文推荐", "相关论文",
            "find paper", "look for", "search for",
        ],
        IntentType.QA: [
            "回答", "问答", "提问", "请问", "问题",
            "question", "answer", "ask",
        ],
        IntentType.COMPARE: [
            "对比", "比较", "compare", "comparison", "区别",
            "差异", "不同", "vs", "versus", "和.*哪个",
            "有什么不同", "有什么区别",
        ],
        IntentType.ANALYZE: [
            "分析", "analyze", "analysis", "研究方法", "实验设计",
            "评估", "评价", "evaluate",
        ],
        IntentType.FIND_METHOD: [
            "方法", "method", "算法", "algorithm", "模型结构",
            "架构", "architecture", "怎么做的", "怎么实现",
            "用了什么方法", "用什么模型",
        ],
        IntentType.FIND_RESULT: [
            "结果", "result", "效果", "性能", "performance",
            "准确率", "accuracy", "指标", "metric", "benchmark",
            "实验", "experiment", "表现",
        ],
        IntentType.FIND_RELATED: [
            "相关工作", "related work", "背景", "background",
            "前人", "已有研究", "文献综述", "literature",
        ],
    }

    def recognize(self, query: str) -> IntentResult:
        """识别意图"""
        query_lower = query.lower().strip()

        best_intent = IntentType.UNKNOWN
        best_score = 0.0
        matched_patterns: list[str] = []

        for intent, patterns in self.INTENT_PATTERNS.items():
            score = 0.0
            matched = []
            for pattern in patterns:
                import re
                if re.search(pattern, query_lower):
                    score += 1.0
                    matched.append(pattern)
            if score > best_score:
                best_score = score
                best_intent = intent
                matched_patterns = matched

        # 如果没有任何匹配，判断是否包含问句特征
        if best_intent == IntentType.UNKNOWN:
            if any(q in query for q in ["？", "?", "吗", "呢", "什么", "怎么", "如何", "怎样"]):
                best_intent = IntentType.QA

        # 计算置信度
        confidence = min(best_score / 3.0, 1.0) if best_score > 0 else 0.3

        return IntentResult(
            intent=best_intent,
            confidence=confidence,
            entities={},
            params={"matched_patterns": matched_patterns},
            raw_query=query,
        )

    def is_about_current_paper(self, query: str) -> bool:
        """判断是否针对当前打开的论文"""
        current_paper_indicators = [
            "这篇", "这个", "本文", "当前", "这段", "这页",
            "上面", "这段文字", "这里", "此处", "文中",
            "this paper", "this article", "this work",
            "the paper", "the article",
        ]
        query_lower = query.lower()
        return any(indicator in query_lower for indicator in current_paper_indicators)

    def extract_language_preference(self, query: str) -> Optional[str]:
        """提取语言偏好"""
        if any(w in query for w in ["中文", "汉语", "用中文", "翻译成中文"]):
            return "zh"
        if any(w in query for w in ["英文", "英语", "用英文", "translate to english"]):
            return "en"
        if any(w in query for w in ["日文", "日语", "翻译成日文"]):
            return "ja"
        return None
