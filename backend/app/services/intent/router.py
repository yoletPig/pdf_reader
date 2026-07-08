"""意图 → Agent 路由表"""
from app.services.intent.intent_types import IntentType


# 意图到 Agent 模式的映射表
INTENT_TO_AGENT: dict[IntentType, str] = {
    IntentType.QUICK_TRANSLATE: "quick_translate",
    IntentType.POLISH_TRANSLATE: "polish_translate",
    IntentType.BATCH_TRANSLATE: "batch_translate",
    IntentType.TERM_EXPLAIN: "concept_explain",
    IntentType.PARAGRAPH_EXPLAIN: "concept_explain",
    IntentType.FORMULA_EXPLAIN: "concept_explain",
    IntentType.SINGLE_PAPER_QA: "cross_paper_qa",
    IntentType.CROSS_PAPER_QA: "cross_paper_qa",
    IntentType.METHOD_COMPARE: "cross_paper_qa",
    IntentType.PAPER_SEARCH: "paper_search",
    IntentType.SIMILAR_RECOMMEND: "similar_recommend",
    IntentType.NOTE_MANAGE: "note_manage",
    IntentType.KB_MANAGE: "kb_manage",
}

# 意图到 API 端点的映射表
INTENT_TO_ENDPOINT: dict[IntentType, str] = {
    IntentType.QUICK_TRANSLATE: "/api/translate",
    IntentType.POLISH_TRANSLATE: "/api/translate",
    IntentType.BATCH_TRANSLATE: "/api/translate/batch",
    IntentType.TERM_EXPLAIN: "/api/explain",
    IntentType.PARAGRAPH_EXPLAIN: "/api/explain",
    IntentType.FORMULA_EXPLAIN: "/api/explain",
    IntentType.SINGLE_PAPER_QA: "/api/rag/query",
    IntentType.CROSS_PAPER_QA: "/api/rag/query",
    IntentType.METHOD_COMPARE: "/api/rag/query",
    IntentType.PAPER_SEARCH: "/api/search",
    IntentType.SIMILAR_RECOMMEND: "/api/search/similar",
    IntentType.NOTE_MANAGE: "/api/notes",
    IntentType.KB_MANAGE: "/api/papers",
}


def get_agent_for_intent(intent: IntentType) -> str:
    """根据意图获取对应的 Agent 模式"""
    return INTENT_TO_AGENT.get(intent, "custom")


def get_endpoint_for_intent(intent: IntentType) -> str:
    """根据意图获取对应的 API 端点"""
    return INTENT_TO_ENDPOINT.get(intent, "/api/agent/execute")
