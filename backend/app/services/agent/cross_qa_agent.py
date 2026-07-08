"""跨论文问答 Agent (RAG 增强)"""
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.prompt.manager import prompt_manager


class CrossQAAgent(BaseAgent):
    name = "cross_paper_qa"
    description = "RAG 增强的多论文问答，引用来源标注、对比分析"
    prompt_mode = "cross_qa"

    async def execute(self, request: AgentRequest) -> AgentResponse:
        question = request.params.get("question", "")
        context = request.params.get("rag_context", "")

        messages = prompt_manager.build_prompt(
            mode=self.prompt_mode,
            task="cross_paper_qa",
            variables={"question": question, "context": context},
        )

        return AgentResponse(
            content=f"[待 LLM + RAG 生成] 回答: {question[:50]}...",
            agent_name=self.name,
            sources=request.params.get("sources", []),
        )
