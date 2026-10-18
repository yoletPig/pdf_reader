"""数据库连接管理"""
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DATABASE_ECHO,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
)

async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """获取数据库会话的依赖注入"""
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    """初始化数据库表"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_apply_lightweight_migrations)


def _apply_lightweight_migrations(sync_conn):
    """为本地 SQLite 开发环境补齐新增字段。"""
    inspector = inspect(sync_conn)
    tables = set(inspector.get_table_names())

    if "papers" in tables:
        paper_columns = {column["name"] for column in inspector.get_columns("papers")}
        migrations = {
            "page_count": "ALTER TABLE papers ADD COLUMN page_count INTEGER DEFAULT 0",
            "pdf_metadata_json": "ALTER TABLE papers ADD COLUMN pdf_metadata_json TEXT DEFAULT '{}'",
            "ai_summary_md": "ALTER TABLE papers ADD COLUMN ai_summary_md TEXT DEFAULT ''",
            "reader_profile_json": "ALTER TABLE papers ADD COLUMN reader_profile_json TEXT DEFAULT '{}'",
            "source_url": "ALTER TABLE papers ADD COLUMN source_url VARCHAR(1000) DEFAULT ''",
            "document_type": "ALTER TABLE papers ADD COLUMN document_type VARCHAR(50) DEFAULT 'pdf'",
            "markdown_path": "ALTER TABLE papers ADD COLUMN markdown_path VARCHAR(1000) DEFAULT ''",
            "folder_id": "ALTER TABLE papers ADD COLUMN folder_id VARCHAR(36) DEFAULT ''",
        }
        for column, sql in migrations.items():
            if column not in paper_columns:
                sync_conn.execute(text(sql))

    if "agent_runs" in tables:
        agent_run_columns = {column["name"] for column in inspector.get_columns("agent_runs")}
        migrations = {
            "error_type": "ALTER TABLE agent_runs ADD COLUMN error_type VARCHAR(100) DEFAULT ''",
            "duration_ms": "ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER DEFAULT 0",
        }
        for column, sql in migrations.items():
            if column not in agent_run_columns:
                sync_conn.execute(text(sql))

    if "translation_cache" in tables:
        translation_columns = {column["name"] for column in inspector.get_columns("translation_cache")}
        migrations = {
            "finish_reason": "ALTER TABLE translation_cache ADD COLUMN finish_reason VARCHAR(50) DEFAULT ''",
            "prompt_tokens": "ALTER TABLE translation_cache ADD COLUMN prompt_tokens INTEGER DEFAULT 0",
            "completion_tokens": "ALTER TABLE translation_cache ADD COLUMN completion_tokens INTEGER DEFAULT 0",
            "source_text_length": "ALTER TABLE translation_cache ADD COLUMN source_text_length INTEGER DEFAULT 0",
            "translated_text_length": "ALTER TABLE translation_cache ADD COLUMN translated_text_length INTEGER DEFAULT 0",
            "edited_by_user": "ALTER TABLE translation_cache ADD COLUMN edited_by_user BOOLEAN DEFAULT 0",
            "edited_at": "ALTER TABLE translation_cache ADD COLUMN edited_at DATETIME",
            "user_notes": "ALTER TABLE translation_cache ADD COLUMN user_notes TEXT DEFAULT ''",
            "updated_at": "ALTER TABLE translation_cache ADD COLUMN updated_at DATETIME",
        }
        for column, sql in migrations.items():
            if column not in translation_columns:
                sync_conn.execute(text(sql))
