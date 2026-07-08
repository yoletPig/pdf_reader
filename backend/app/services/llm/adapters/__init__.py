"""LLM 适配器"""
from app.services.llm.adapters.base import BaseAdapter
from app.services.llm.adapters.openai_adapter import OpenAIAdapter

__all__ = ["BaseAdapter", "OpenAIAdapter"]
