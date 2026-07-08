"""严谨润色 Agent"""
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.prompt.manager import prompt_manager


class PolishTranslateAgent(BaseAgent):
    name = "polish_translate"
    description = "段落精翻、学术润色，符合中文学术表达规范"
    prompt_mode = "polish_translate"

    def __init__(self, llm_router=None):
        super().__init__()
        self._llm_router = llm_router

    def set_llm_router(self, router):
        """注入 LLM 路由器"""
        self._llm_router = router

    async def execute(self, request: AgentRequest) -> AgentResponse:
        text = request.params.get("text", "")
        context = request.params.get("context", "")
        terminology = request.params.get("terminology", {})

        messages = prompt_manager.build_prompt(
            mode=self.prompt_mode,
            task="translate_paragraph",
            variables={"text": text, "context": context},
            terminology=terminology,
        )

        if not self._llm_router:
            return AgentResponse(
                content=f"[LLM 未配置] 精翻: {text[:50]}...",
                agent_name=self.name,
            )

        from app.services.llm.types import LLMRequest, LLMMessage

        llm_messages = [LLMMessage(role=m.role, content=m.content) for m in messages]
        llm_request = LLMRequest(messages=llm_messages, temperature=0.3, max_tokens=4096)
        response = await self._llm_router.chat(llm_request)

        return AgentResponse(
            content=response.content,
            agent_name=self.name,
            metadata={
                "model_used": response.model,
                "tokens_used": response.total_tokens,
            },
        )
