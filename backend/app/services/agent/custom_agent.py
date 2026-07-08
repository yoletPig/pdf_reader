"""自定义 Agent"""
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.prompt.manager import prompt_manager


class CustomAgent(BaseAgent):
    name = "custom"
    description = "用户自定义 Agent，用户配置 Prompt + 参数"
    prompt_mode = "custom"

    async def execute(self, request: AgentRequest) -> AgentResponse:
        system_prompt = request.params.get("system_prompt", "")
        task_prompt = request.params.get("task_prompt", "")

        return AgentResponse(
            content=f"[待 LLM 生成] 自定义执行: {task_prompt[:50]}...",
            agent_name=self.name,
        )
