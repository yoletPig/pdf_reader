"""解释 API"""
from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/api/explain", tags=["解释"])


@router.post("")
async def explain(data: dict):
    """解释术语/段落/公式"""
    # TODO: 实现解释服务
    return {"explanation": f"解释: {data.get('text', '')[:50]}...", "type": data.get("type", "term")}
