import asyncio
import os
from collections.abc import AsyncGenerator

from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import settings

# Use the unpooled direct connection URL when available.
# The Neon-Vercel integration provides DATABASE_URL_UNPOOLED pointing to the
# direct Neon endpoint (no PgBouncer). Using the direct endpoint allows
# statement_cache_size > 0 — asyncpg caches prepared statements and performs
# type introspection once per connection lifetime rather than per query.
# Under concurrent load, repeated type introspection with statement_cache_size=0
# exhausts Neon's per-process MessageContext RAM, causing OutOfMemoryError.
# Falls back to DATABASE_URL (settings.database_url) for local development.
_engine_url = os.environ.get("DATABASE_URL_UNPOOLED") or settings.database_url

# Persistent pool sized for Fluid Compute concurrency.
#
# Architecture rationale (Vercel Fluid Compute + Neon direct connections):
# - pool_size=20: direct Neon connections are used (no PgBouncer pooler). Each
#   Lambda instance holds up to 20 connections. Neon connection limits apply
#   directly, so reduce DB_POOL_SIZE env var if approaching Neon's per-project
#   connection limit across many concurrent Lambda instances.
# - max_overflow=10: burst headroom up to 30 total connections per Lambda instance.
# - pool_pre_ping=True: detects if Neon compute suspended mid-session and reconnects
#   transparently on the next request.
# - pool_recycle=300: recycles connections held for 5+ minutes to prevent stale state.
# - pool_timeout=10: longer wait (10s) since more connections are available, reducing
#   the likelihood of TimeoutError under concurrent load.
#
# statement_cache_size=100: With a direct Neon connection (no PgBouncer transaction
# mode), asyncpg can cache up to 100 prepared statements per connection. This
# eliminates per-query type introspection, which is the root cause of
# asyncpg.exceptions.OutOfMemoryError under concurrent E2E shard load.
# (statement_cache_size=0 is only required for PgBouncer transaction mode.)
#
# timeout=5 sets a 5-second asyncpg connection timeout. When Neon is waking from
# auto-suspend the TCP connection can hang indefinitely without this guard. asyncpg
# raises an asyncio.TimeoutError (wrapped in OperationalError by SQLAlchemy) after
# 5 seconds, which triggers the get_db() retry logic below.
#
# Neon auto-suspend note: the free/launch Neon plan auto-suspends the compute after
# 5 minutes of idle. This cannot be disabled programmatically on those tiers. When a
# Lambda request arrives during wake-up the connection attempt raises OperationalError.
# get_db() below retries up to 5× with exponential backoff (2s, 4s, 8s, 16s — 30s
# total wait) to cover Neon's full 20-30s wake-up window. Cold-start requests block
# briefly and return a real response rather than failing with a 500.
# Total worst-case latency: 5×5s + 2+4+8+16 = 55s — within Playwright's 180s timeout.
engine = create_async_engine(
    _engine_url,
    echo=False,
    future=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={
        # statement_cache_size=0 is required only for PgBouncer transaction mode.
        # With a direct Neon connection (no pooler), we can cache up to 100 prepared
        # statements per connection, eliminating per-query type introspection.
        "statement_cache_size": 100,
        "timeout": 5,
    },
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# Maximum number of attempts when the DB connection fails with a transient error.
_DB_RETRY_ATTEMPTS = 5
# Base wait in seconds between retries (doubles each attempt: 2s, 4s, 8s, 16s).
_DB_RETRY_BASE_WAIT = 2


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Provide a DB session with retry logic for transient Neon compute wake-up errors.

    When Neon auto-suspends and a request arrives during wake-up, SQLAlchemy raises
    OperationalError or DBAPIError. Under Fluid Compute, concurrent requests can also
    exhaust the QueuePool (SQLAlchemyTimeoutError) or hit a TCP timeout
    (asyncio.TimeoutError). All four are retried up to _DB_RETRY_ATTEMPTS times with
    exponential backoff (_DB_RETRY_BASE_WAIT * 2^attempt seconds: 2s, 4s, 8s, 16s) to
    give the compute time to become ready before propagating the error.
    """
    last_err: Exception | None = None
    for attempt in range(_DB_RETRY_ATTEMPTS):
        try:
            async with AsyncSessionLocal() as session:
                yield session
                return
        except (OperationalError, DBAPIError, SQLAlchemyTimeoutError, asyncio.TimeoutError) as exc:
            last_err = exc
            if attempt < _DB_RETRY_ATTEMPTS - 1:
                wait = _DB_RETRY_BASE_WAIT * (2 ** attempt)
                await asyncio.sleep(wait)
    raise last_err  # type: ignore[misc]
