"""Agent / Tool 注册中心"""
from app.services.agent_harness.agents.paper_qa import PaperQAAgent
from app.services.agent_harness.tools.citation_tools import CitationVerifyTool
from app.services.agent_harness.tools.rag_tools import RetrieveChunksTool


class HarnessRegistry:
    def __init__(self, db):
        self._agents = {
            "paper_qa": PaperQAAgent(),
        }
        self._tools = {
            "rag.retrieve": RetrieveChunksTool(db),
            "citation.verify": CitationVerifyTool(),
        }

    def get_agent(self, name: str):
        agent = self._agents.get(name)
        if not agent:
            raise ValueError(f"unknown agent: {name}")
        return agent

    def get_tool(self, name: str):
        tool = self._tools.get(name)
        if not tool:
            raise ValueError(f"unknown tool: {name}")
        return tool
