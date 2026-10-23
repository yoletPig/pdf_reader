"""每日论文 API - HuggingFace / ModelScope 每日推荐"""
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.notification import Notification
from app.services.daily_papers import fetch_daily_papers

router = APIRouter(prefix="/api/daily-papers", tags=["每日论文"])


@router.get("")
async def get_daily_papers(
    source: str = "all",
    date: str = "",
    refresh: bool = False,
    limit: int = 30,
    db: AsyncSession = Depends(get_db),
):
    """每日论文推荐。source: all / huggingface / modelscope；date: YYYY-MM-DD（HF 支持按日期）"""
    result = await fetch_daily_papers(source=source, date=date, refresh=refresh, limit=limit)

    # 今日首次拉取成功后生成一条收件箱提醒（幂等）
    today = datetime.now().strftime("%Y-%m-%d")
    if result["papers"]:
        key = f"papers:{today}"
        exists = (await db.execute(
            select(Notification.id).where(Notification.dedupe_key == key)
        )).first()
        if not exists:
            db.add(Notification(
                type="papers",
                title="📚 每日论文已更新",
                body=f"今日推荐 {len(result['papers'])} 篇论文（HuggingFace {result['sources'].get('huggingface', 0)} · ModelScope {result['sources'].get('modelscope', 0)}）",
                link="/#papers",
                dedupe_key=key,
            ))
            await db.commit()

    return result
