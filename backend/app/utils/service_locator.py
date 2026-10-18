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
        """自动注入所有服务间的依赖关系，并加载运行时设置覆盖值"""
        from app.database import async_session_factory
        from app.services.llm import llm_router
        from app.services.translation import translation_service
        from app.services.pdf.service import pdf_service
        from app.services import settings_store

        translation_service.set_llm_router(llm_router)

        self._services.update({
            "llm_router": llm_router,
            "translation_service": translation_service,
            "pdf_service": pdf_service,
        })

        # 应用数据库中的运行时设置（PDF 引擎、模型配置覆盖）
        try:
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(self._apply_runtime_settings())
            else:
                loop.run_until_complete(self._apply_runtime_settings())
        except Exception as exc:
            print(f"⚠️ 运行时设置加载失败: {exc}")

        print("✅ 服务依赖注入完成")

    async def _apply_runtime_settings(self):
        """启动时把数据库中的设置覆盖值应用到各服务。"""
        from app.database import async_session_factory
        from app.services import settings_store

        async with async_session_factory() as db:
            # PDF 引擎
            await settings_store.refresh_pdf_engine_cache(db)
            # 模型配置（数据库覆盖 > .env）
            from app.api.config import _effective_llm_config
            from app.services.llm import llm_router
            cfg = await _effective_llm_config(db)
            await llm_router.apply_config(cfg)
            print(f"  📄 PDF 引擎: {settings_store.current_pdf_engine()}")
            print(f"  🤖 模型: {cfg.model} base_url={cfg.base_url or '(默认)'}")


# 全局单例
service_locator = ServiceLocator()
