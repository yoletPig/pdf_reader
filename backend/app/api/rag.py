"""兼容旧前端的 RAG 问答 API"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.agent_harness import agent_run_service

router = APIRouter(prefix="/api/rag", tags=["RAG问答"])


@router.post("/query")
async def rag_query(data: dict, db: AsyncSession = Depends(get_db)):
    """使用最小 harness 跑通 paper_qa"""
    try:
        paper_ids = data.get("paper_ids") or []
        paper_id = paper_ids[0] if isinstance(paper_ids, list) and paper_ids else None
        result = await agent_run_service.create_run(
            db,
            agent_name="paper_qa",
            agent_input={
                "question": data.get("question", ""),
                "paper_id": paper_id,
                "top_k": data.get("top_k", 5),
            },
            context_data={"paper_id": paper_id},
        )
        return {
            "run_id": result.run_id,
            "answer": result.answer.content,
            "sources": [source.model_dump() for source in result.answer.sources],
            "trace_summary": result.answer.trace_summary,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
