"""FastAPI 应用入口"""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.database import init_db

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
# 将 app 内的 logger 都设为 INFO 级别
logging.getLogger("app").setLevel(logging.INFO)


async def load_llm_from_settings():
    """从环境变量加载单模型配置。"""
    from app.services.llm import llm_router

    await llm_router.reload_from_settings()
    key_status = "已配置" if settings.LLM_API_KEY else "❌ 未配置"
    print(
        f"  🤖 单模型: {settings.LLM_MODEL} "
        f"base_url={settings.LLM_BASE_URL or '(默认)'} api_key={key_status}"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期"""
    # 启动时
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    settings.PAPERS_DIR.mkdir(parents=True, exist_ok=True)
    settings.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    await init_db()
    await load_llm_from_settings()
    # 注入服务依赖
    from app.utils.service_locator import service_locator
    service_locator.wire_all()
    print(f"✅ {settings.APP_NAME} v{settings.APP_VERSION} 已启动")
    yield
    # 关闭时
    print("👋 服务关闭")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    lifespan=lifespan,
)

# CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check():
    """健康检查"""
    return {"status": "ok", "version": settings.APP_VERSION}


# 注册所有 API 路由
from app.api import papers, search, translation, explain, rag, config, prompts, notes, intent_api, agent_api, agent_runs

app.include_router(papers.router)
app.include_router(search.router)
app.include_router(translation.router)
app.include_router(explain.router)
app.include_router(rag.router)
app.include_router(config.router)
app.include_router(prompts.router)
app.include_router(notes.router)
app.include_router(intent_api.router)
app.include_router(agent_api.router)
app.include_router(agent_runs.router)
