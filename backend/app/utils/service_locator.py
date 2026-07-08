"""服务定位器 - 统一管理所有服务的依赖注入"""
from typing import Optional


class ServiceLocator:
    """服务定位器，管理全局服务实例和依赖注入"""

    def __init__(self):
        self._services: dict[str, object] = {}

    def register(self, name: str, service: object):
        """注册服务"""
        self._services[name] = service

    def get(self, name: str) -> Optional[object]:
        """获取服务"""
        return self._services.get(name)

    def wire_all(self):
        """自动注入所有服务间的依赖关系"""
        from app.services.llm import llm_router
        from app.services.translation import translation_service
        from app.services.rag import rag_engine
        from app.services.intent import IntentEngine
        from app.services.agent import agent_orchestrator
        from app.services.knowledge_base.paper_ingestion import ingestion_pipeline
        from app.services.pdf import pdf_service

        # 注入 LLM 路由器到各服务（使用 hasattr 检查，因为不是所有服务都有 set_llm_router）
        translation_service.set_llm_router(llm_router)
        if hasattr(rag_engine, 'set_llm_router'):
            rag_engine.set_llm_router(llm_router)

        # 注入 LLM 路由器到所有 Agent
        for agent in agent_orchestrator.list_agents():
            if hasattr(agent, 'set_llm_router'):
                agent.set_llm_router(llm_router)

        # 注入 PDF 服务和 RAG 引擎到摄入管线
        ingestion_pipeline.set_services(pdf_service, rag_engine)

        self._services.update({
            "llm_router": llm_router,
            "translation_service": translation_service,
            "rag_engine": rag_engine,
            "pdf_service": pdf_service,
            "agent_orchestrator": agent_orchestrator,
            "ingestion_pipeline": ingestion_pipeline,
        })

        print("✅ 服务依赖注入完成")


# 全局单例
service_locator = ServiceLocator()
