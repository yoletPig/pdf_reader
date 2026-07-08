"""论文检索 API"""
from typing import Optional
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/search", tags=["论文检索"])


@router.get("")
async def search_papers(
    query: str,
    source: Optional[str] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    max_results: int = 20,
):
    """多源检索论文"""
    # TODO: 实现多源聚合检索
    return {
        "query": query,
        "results": [],
        "total": 0,
    }


@router.post("/import")
async def import_paper(data: dict):
    """从检索结果导入论文"""
    # TODO: 下载 PDF + 自动摄入管线
    return {"message": "导入成功", "paper_id": "placeholder"}
