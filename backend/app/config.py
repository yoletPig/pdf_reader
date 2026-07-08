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

    # 向量数据库
    VECTOR_DB_TYPE: str = "chromadb"  # chromadb / milvus_lite
    VECTOR_DB_PATH: str = "./data/vectors"

    # Embedding
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"
    EMBEDDING_DEVICE: str = "cpu"
    EMBEDDING_API_KEY: Optional[str] = None
    EMBEDDING_API_URL: Optional[str] = None

    # 单模型 LLM 配置
    LLM_MODEL: str = "gpt-4o-mini"
    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = "https://api.openai.com/v1"
    LLM_TRUST_ENV: bool = False
    LLM_MAX_TOKENS: int = 4096
    LLM_TEMPERATURE: float = 0.3

    # 翻译缓存
    TRANSLATION_CACHE_SIZE: int = 10000
    TRANSLATION_CACHE_TTL: int = 86400 * 30  # 30 days

    # RAG 配置
    RAG_DEFAULT_TOP_K: int = 10
    RAG_CHUNK_SIZE: int = 512
    RAG_CHUNK_OVERLAP: int = 64
    RAG_MAX_CONTEXT_TOKENS: int = 8000

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
