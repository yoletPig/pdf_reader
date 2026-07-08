"""概念解释 Agent"""
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.prompt.manager import prompt_manager


class ConceptExplainAgent(BaseAgent):
    name = "concept_explain"
    description = "术语/段落/公式解读，分层解释（简明→深入）"
    prompt_mode = "concept_explain"

    async def execute(self, request: AgentRequest) -> AgentResponse:
        term = request.params.get("term", "")
        text = request.params.get("text", "")
        paragraph = request.params.get("paragraph", "")
        paper_topic = request.params.get("paper_topic", "")

        if term:
            # 术语解释
            messages = prompt_manager.build_prompt(
                mode=self.prompt_mode,
                task="explain_term",
                variables={
                    "term": term,
                    "paragraph": paragraph or text,
                    "paper_topic": paper_topic,
                },
            )
        else:
            # 段落解释
            messages = prompt_manager.build_prompt(
                mode=self.prompt_mode,
                task="explain_paragraph",
                variables={"text": text, "paper_topic": paper_topic},
            )

        return AgentResponse(
            content=f"[待 LLM 生成] 解释: {(term or text)[:50]}...",
            agent_name=self.name,
        )
