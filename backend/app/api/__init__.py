"""API 路由层"""
from app.api import papers, search, translation, config, prompts, agent_proxy

__all__ = [
    "papers",
    "search",
    "translation",
    "config",
    "prompts",
    "agent_proxy",
]
