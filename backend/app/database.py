import asyncio
from collections.abc import AsyncGenerator

from sqlalchemy.exc import DBAPIError, OperationalError
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
# timeout=5 sets a 5-second asyncpg connection timeout. When Neon is waking from
# auto-suspend the TCP connection can hang indefinitely without this guard. asyncpg
# raises an asyncio.TimeoutError (wrapped in OperationalError by SQLAlchemy) after
# 5 seconds, which triggers the get_db() retry logic below. Using 5s (rather than
# 10s) keeps total retry time (5s + 1s + 5s + 2s + 5s = 18s) well within the 60s
# Playwright E2E timeout.
#
# Neon auto-suspend note: the free/launch Neon plan auto-suspends the compute after
# 5 minutes of idle. This cannot be disabled programmatically on those tiers. When a
# Lambda request arrives during wake-up the connection attempt raises OperationalError.
# get_db() below retries up to 3× with exponential backoff to give the compute time
# to become ready before surfacing a 500 to the client.
engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={"statement_cache_size": 0, "timeout": 5},
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# Maximum number of attempts when the DB connection fails with a transient error.
_DB_RETRY_ATTEMPTS = 3
# Base wait in seconds between retries (doubles each attempt: 1s, 2s).
_DB_RETRY_BASE_WAIT = 1


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Provide a DB session with retry logic for transient Neon compute wake-up errors.

    When Neon auto-suspends and a request arrives during wake-up, SQLAlchemy raises
    OperationalError or DBAPIError. We retry up to _DB_RETRY_ATTEMPTS times with
    exponential backoff (_DB_RETRY_BASE_WAIT * 2^attempt seconds: 1s, 2s) to give
    the compute time to become ready before propagating the error.
    """
    last_err: Exception | None = None
    for attempt in range(_DB_RETRY_ATTEMPTS):
        try:
            async with AsyncSessionLocal() as session:
                yield session
                return
        except (OperationalError, DBAPIError) as exc:
            last_err = exc
            if attempt < _DB_RETRY_ATTEMPTS - 1:
                wait = _DB_RETRY_BASE_WAIT * (2 ** attempt)
                await asyncio.sleep(wait)
    raise last_err  # type: ignore[misc]
