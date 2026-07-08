"""快速翻译 Agent"""
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.prompt.manager import prompt_manager


class QuickTranslateAgent(BaseAgent):
    name = "quick_translate"
    description = "选中文本即时翻译，流畅通顺、速度优先"
    prompt_mode = "quick_translate"

    def __init__(self, llm_router=None):
        super().__init__()
        self._llm_router = llm_router

    def set_llm_router(self, router):
        """注入 LLM 路由器"""
        self._llm_router = router

    async def execute(self, request: AgentRequest) -> AgentResponse:
        text = request.params.get("text", "")
        context = request.params.get("context", "")

        messages = prompt_manager.build_prompt(
            mode=self.prompt_mode,
            task="translate_sentence" if len(text) <= 200 else "translate_paragraph",
            variables={"text": text, "context": context},
        )

        if not self._llm_router:
            return AgentResponse(
                content=f"[LLM 未配置] 翻译: {text[:50]}...",
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
