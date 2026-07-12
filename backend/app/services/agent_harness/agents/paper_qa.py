"""paper_qa Agent"""
from sqlalchemy import select

from app.services.agent_harness.agents.base import AgentProfile
from app.services.agent_harness.agents.base import BaseHarnessAgent
from app.services.agent_harness.context import RunContext
from app.services.agent_harness.schemas import PaperQAAnswer
from app.services.llm import LLMMessage, LLMRequest
from app.models.paper import Paper


class PaperQAAgent(BaseHarnessAgent):
    profile = AgentProfile(
        name="paper_qa",
        description="基于论文上下文回答问题，并返回可追溯来源。",
        system_prompt_key="agent.paper_qa.system",
        allowed_tools=["rag.retrieve", "citation.verify"],
        output_schema=PaperQAAnswer,
        max_steps=4,
        require_citations=True,
    )

    async def run(self, agent_input: dict, ctx: RunContext, runtime: "AgentHarnessRuntime") -> dict:
        question = (agent_input.get("question") or "").strip()
        if not question:
            raise ValueError("question is required")
        conversation_history = ctx.metadata.get("conversation_history", [])[-6:]
        await runtime.emit(
            "plan_created",
            {
                "agent": self.name,
                "max_steps": self.profile.max_steps,
                "steps": ["rag.retrieve", "llm.answer", "citation.verify"],
            },
        )

        paper_profile_context = ""
        if ctx.paper_id:
            paper = (
                await runtime.registry.db.execute(select(Paper).where(Paper.id == ctx.paper_id))
            ).scalar_one_or_none()
            if paper:
                paper_profile_context = (
                    f"论文标题：{paper.title or '未知标题'}\n"
                    f"论文摘要：{paper.abstract or '暂无摘要'}\n\n"
                    f"论文画像 / 全文总结：\n{paper.ai_summary_md or '暂无论文画像'}"
                )

        selection_hint = ""
        if ctx.selected_text:
            selection_hint = f"\n\n补充线索（来自用户选中的片段，仅供参考，不代表答案范围限制）：\n{ctx.selected_text}"
        history_hint = ""
        if conversation_history:
            rendered_history = []
            for turn in conversation_history:
                role = "用户" if turn.get("role") == "user" else "助手"
                rendered_history.append(f"{role}: {turn.get('content', '')}")
            history_hint = "\n\n历史对话（用于追问理解）:\n" + "\n\n".join(rendered_history)

        retrieval = None
        verified_sources = None
        answer_content = ""

        for _ in range(self.profile.max_steps):
            if retrieval is None:
                retrieval = await runtime.call_tool(
                    "rag.retrieve",
                    {
                        "question": question,
                        "paper_id": ctx.paper_id,
                        "top_k": agent_input.get("top_k", 8),
                    },
                    ctx,
                )
                if not retrieval.sources:
                    answer_content = "当前检索上下文不足，无法基于论文内容给出可靠回答。请尝试缩小问题范围，或先定位到相关论文和页面。"
                    break
                continue

            if not answer_content:
                rag_context = "\n\n".join(
                    [
                        f"[{idx}] {source.paper_title} p.{source.page}\n{source.chunk_text}"
                        for idx, source in enumerate(retrieval.sources, start=1)
                    ]
                )
                response = await runtime.call_llm(
                    LLMRequest(
                        messages=[
                            LLMMessage(
                                role="system",
                                content=(
                                    "你是一个论文问答助手。只能基于给定上下文回答。"
                                    "如果上下文不足，明确说明信息不足。"
                                    "回答使用中文，先给结论，再给简要依据。"
                                    "如果当前问题是追问，必须结合历史对话解析代词、省略和上下文承接。"
                                ),
                            ),
                            LLMMessage(
                                role="user",
                                content=(
                                    f"问题：{question}{selection_hint}{history_hint}\n\n"
                                    f"论文全局信息：\n{paper_profile_context or '暂无全局信息'}\n\n"
                                    f"检索上下文：\n{rag_context or '无可用上下文'}"
                                ),
                            ),
                        ],
                        max_tokens=1200,
                        temperature=0.2,
                    )
                )
                answer_content = response.content
                continue

            if self.profile.require_citations and verified_sources is None:
                verified_sources = await runtime.call_tool(
                    "citation.verify",
                    {"sources": [source.model_dump() for source in retrieval.sources]},
                    ctx,
                )
                await runtime.emit(
                    "citation_checked",
                    {"total": len(retrieval.sources), "valid": len(verified_sources.sources)},
                )
                break

        return {
            "content": answer_content,
            "sources": [
                source.model_dump()
                for source in (verified_sources.sources if verified_sources else (retrieval.sources if retrieval else []))
            ],
        }
