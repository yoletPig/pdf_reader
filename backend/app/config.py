"""全局配置管理"""
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """应用全局配置"""

    # 应用
    APP_NAME: str = "PDF Reader Agent"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = True

    # 数据库
    DATABASE_URL: str = "sqlite+aiosqlite:///./data/db/pdf_reader.db"
    DATABASE_ECHO: bool = False

    # 文件存储
    DATA_DIR: Path = Path(__file__).parent.parent / "data"
    PAPERS_DIR: Path = DATA_DIR / "papers"
    CACHE_DIR: Path = DATA_DIR / "cache"

    # PDF 解析引擎：pymupdf（快速文本提取）/ docling（深度结构解析）
    # 运行时可在系统设置页覆盖（存于 app_settings 表）
    PDF_ENGINE: str = "pymupdf"

    # 单模型 LLM 配置（agent / 翻译 / 总结共用，运行时可在设置页覆盖）
    LLM_MODEL: str = "gpt-4o-mini"
    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = "https://api.openai.com/v1"
    # 是否信任 http_proxy/https_proxy 等环境代理变量。
    # 服务器需代理访问自定义 LLM 地址时务必开启（默认开启）。
    LLM_TRUST_ENV: bool = True
    LLM_MAX_TOKENS: int = 128000
    LLM_TEMPERATURE: float = 0.3
    # 单次 LLM 请求超时（秒）。长页翻译 + 代理链路可能耗时较久（实测 ~85s），
    # 默认 300s 避免误杀；过长可调小，超时则按该值失败。
    LLM_TIMEOUT: float = 300.0

    # agent-gateway (Node/pi agent) 服务地址
    AGENT_GATEWAY_URL: str = "http://127.0.0.1:8002"

    # 翻译缓存
    TRANSLATION_CACHE_SIZE: int = 10000
    TRANSLATION_CACHE_TTL: int = 86400 * 30  # 30 days

    # 论文检索
    SEARCH_TIMEOUT: int = 30
    SEARCH_MAX_RESULTS: int = 50

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # 安全
    SECRET_KEY: str = "change-me-in-production"

    model_config = {"env_prefix": "PDF_READER_", "env_file": ".env"}

    def is_llm_configured(self) -> bool:
        return bool(self.LLM_API_KEY.strip() and self.LLM_BASE_URL.strip() and self.LLM_MODEL.strip())


settings = Settings()
