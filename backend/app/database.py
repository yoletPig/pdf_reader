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
        }
        for column, sql in migrations.items():
            if column not in paper_columns:
                sync_conn.execute(text(sql))
