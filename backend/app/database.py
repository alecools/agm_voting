from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings

# Small persistent pool: keeps exactly one connection alive per Lambda instance.
#
# Architecture rationale (Vercel Fluid Compute + Neon):
# - pool_size=1: each Lambda instance holds ONE warm connection.
# - This connection keeps Neon compute active for the Lambda instance's lifetime.
# - On Lambda cold-start, the pool establishes one connection (waking Neon once).
# - All subsequent requests within the same Lambda instance reuse the warm connection —
#   no per-request Neon wakeup latency.
# - max_overflow=0: no burst connections; one connection per instance is sufficient.
# - pool_pre_ping=True: detects if Neon compute suspended mid-session and reconnects
#   transparently on the next request.
# - pool_recycle=300: recycles connections held for 5+ minutes to prevent stale state.
# - pool_timeout=30: request fails fast if the single connection is somehow unavailable.
#
# statement_cache_size=0 is required for PgBouncer transaction mode compatibility.
engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={"statement_cache_size": 0},
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
