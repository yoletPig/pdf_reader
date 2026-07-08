"""Agent 编排器"""
from typing import AsyncGenerator, Optional
from app.services.intent.intent_types import IntentResult, IntentType
from app.services.agent.base_agent import BaseAgent, AgentRequest, AgentResponse
from app.services.agent.quick_translate_agent import QuickTranslateAgent
from app.services.agent.polish_translate_agent import PolishTranslateAgent
from app.services.agent.concept_explain_agent import ConceptExplainAgent
from app.services.agent.cross_qa_agent import CrossQAAgent
from app.services.agent.summary_agent import SummaryAgent
from app.services.agent.custom_agent import CustomAgent


class AgentOrchestrator:
    """Agent 编排器 - 多 Agent 协同、工作流编排、状态管理"""

    def __init__(self):
        self._agents: dict[str, BaseAgent] = {}
        self._register_default_agents()

    def _register_default_agents(self):
        """注册默认 Agent"""
        agents = [
            QuickTranslateAgent(),
            PolishTranslateAgent(),
            ConceptExplainAgent(),
            CrossQAAgent(),
            SummaryAgent(),
            CustomAgent(),
        ]
        for agent in agents:
            self.register(agent)

    def register(self, agent: BaseAgent):
        """注册 Agent"""
        self._agents[agent.name] = agent

    def get_agent(self, name: str) -> Optional[BaseAgent]:
        """获取 Agent"""
        return self._agents.get(name)

    def list_agents(self) -> list[BaseAgent]:
        """列出所有 Agent"""
        return list(self._agents.values())

    async def dispatch(self, intent_result: IntentResult) -> AgentResponse:
        """根据意图分发到对应 Agent"""
        agent_name = intent_result.suggested_agent
        agent = self.get_agent(agent_name)

        if not agent:
            # 默认使用跨论文问答 Agent
            agent = self.get_agent("cross_paper_qa")
            if not agent:
                raise ValueError(f"未找到 Agent: {agent_name}")

        request = AgentRequest(
            intent=intent_result.intent.value,
            params=intent_result.params,
            paper_id=intent_result.params.get("paper_id"),
            session_id="default",
        )

        return await agent.execute(request)

    async def dispatch_stream(
        self,
        intent_result: IntentResult,
    ) -> AsyncGenerator[str, None]:
        """流式分发"""
        agent_name = intent_result.suggested_agent
        agent = self.get_agent(agent_name) or self.get_agent("cross_paper_qa")

        if not agent:
            yield "错误：没有可用的 Agent"
            return

        request = AgentRequest(
            intent=intent_result.intent.value,
            params=intent_result.params,
            paper_id=intent_result.params.get("paper_id"),
            session_id="default",
        )

        async for chunk in agent.stream_execute(request):
            yield chunk


# 全局单例
agent_orchestrator = AgentOrchestrator()
