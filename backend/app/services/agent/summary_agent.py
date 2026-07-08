"""摘要总结 Agent"""
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.prompt.manager import prompt_manager


class SummaryAgent(BaseAgent):
    name = "summary"
    description = "论文摘要/章节总结，结构化输出、要点提炼"
    prompt_mode = "summary"

    async def execute(self, request: AgentRequest) -> AgentResponse:
        text = request.params.get("text", "")
        paper_title = request.params.get("paper_title", "")
        paper_abstract = request.params.get("paper_abstract", "")
        requirements = request.params.get("requirements", "请提供结构化总结")

        if text:
            # 章节总结
            messages = prompt_manager.build_prompt(
                mode=self.prompt_mode,
                task="summarize_section",
                variables={"text": text},
            )
        else:
            # 论文总结
            messages = prompt_manager.build_prompt(
                mode=self.prompt_mode,
                task="summarize_paper",
                variables={
                    "paper_title": paper_title,
                    "paper_abstract": paper_abstract,
                    "requirements": requirements,
                },
            )

        return AgentResponse(
            content=f"[待 LLM 生成] 总结: {(text or paper_title)[:50]}...",
            agent_name=self.name,
        )
