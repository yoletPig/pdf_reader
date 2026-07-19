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
        from app.services.pdf.service import pdf_service

        translation_service.set_llm_router(llm_router)

        self._services.update({
            "llm_router": llm_router,
            "translation_service": translation_service,
            "pdf_service": pdf_service,
        })

        print("✅ 服务依赖注入完成")


# 全局单例
service_locator = ServiceLocator()
