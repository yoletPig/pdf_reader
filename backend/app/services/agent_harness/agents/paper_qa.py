"""paper_qa Agent"""
from app.services.agent_harness.agents.base import BaseHarnessAgent
from app.services.agent_harness.context import RunContext
from app.services.llm import LLMMessage, LLMRequest


class PaperQAAgent(BaseHarnessAgent):
    name = "paper_qa"

    async def run(self, agent_input: dict, ctx: RunContext, runtime: "AgentHarnessRuntime") -> dict:
        question = (agent_input.get("question") or "").strip()
        if not question:
            raise ValueError("question is required")

        await runtime.emit("tool_started", {"tool": "rag.retrieve"})
        retrieval = await runtime.registry.get_tool("rag.retrieve").run(
            {"question": question, "paper_id": ctx.paper_id, "top_k": agent_input.get("top_k", 5)},
            ctx,
        )
        await runtime.emit(
            "tool_finished",
            {
                "tool": "rag.retrieve",
                "count": len(retrieval["sources"]),
            },
        )

        context_lines = []
        for idx, source in enumerate(retrieval["sources"], start=1):
            context_lines.append(
                f"[{idx}] {source['paper_title']} p.{source['page']}\n{source['chunk_text']}"
            )
        rag_context = "\n\n".join(context_lines)
        selection_hint = ""
        if ctx.selected_text:
            selection_hint = f"\n\n补充线索（来自用户选中的片段，仅供参考，不代表答案范围限制）：\n{ctx.selected_text}"

        await runtime.emit("llm_started", {"model": runtime.default_model_name})
        response = await runtime.llm_router.chat(
            LLMRequest(
                messages=[
                    LLMMessage(
                        role="system",
                        content=(
                            "你是一个论文问答助手。只能基于给定上下文回答。"
                            "如果上下文不足，明确说明信息不足。"
                            "回答使用中文，先给结论，再给简要依据。"
                        ),
                    ),
                    LLMMessage(
                        role="user",
                        content=f"问题：{question}{selection_hint}\n\n上下文：\n{rag_context or '无可用上下文'}",
                    ),
                ],
                max_tokens=1200,
                temperature=0.2,
            )
        )

        await runtime.emit("tool_started", {"tool": "citation.verify"})
        verified_sources = await runtime.registry.get_tool("citation.verify").run(
            {"sources": retrieval["sources"]},
            ctx,
        )
        await runtime.emit(
            "citation_checked",
            {"total": len(retrieval["sources"]), "valid": len(verified_sources["sources"])},
        )

        return {
            "content": response.content,
            "sources": verified_sources["sources"],
        }
