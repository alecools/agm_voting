"""
Pytest configuration and fixtures for backend tests.

Uses the TEST_DATABASE_URL from environment (or a default) with isolated
transactions per test for complete isolation.

All async fixtures and tests run in a single session-scoped event loop so that
the asyncpg connection pool is not attached to a different loop than the tests.

When running with pytest-xdist (-n auto), each worker creates its own copy of
the test database (agm_test_gw0, agm_test_gw1, etc.) to avoid cross-worker
contention on the same schema.  When running without xdist (PYTEST_XDIST_WORKER
not set), the original agm_test DB is used as before.
"""
import os
from collections.abc import AsyncGenerator

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.database import get_db
from app.models import Base

# Use the test database URL from environment or fall back to default
_BASE_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test",
)


def _worker_db_url() -> str:
    """Return a DB URL scoped to this xdist worker (or the base URL if no worker)."""
    worker_id = os.environ.get("PYTEST_XDIST_WORKER")
    if worker_id is None:
        # Not running under xdist — use the base test DB as before
        return _BASE_DATABASE_URL
    # Running under xdist — use a worker-specific DB name to avoid collisions
    db_name = f"agm_test_{worker_id}"
    base_without_db = _BASE_DATABASE_URL.rsplit("/", 1)[0]
    return f"{base_without_db}/{db_name}"


def _admin_url() -> str:
    """Return a URL to the postgres system DB (used for CREATE/DROP DATABASE)."""
    base_without_db = _BASE_DATABASE_URL.rsplit("/", 1)[0]
    return base_without_db + "/postgres"


def _plain_url(asyncpg_url: str) -> str:
    """Strip the +asyncpg driver suffix for plain asyncpg connections."""
    return asyncpg_url.replace("postgresql+asyncpg://", "postgresql://")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def test_engine():
    """Create an async engine for the test session.

    When running under xdist, creates a per-worker copy of the test database
    (migrated via alembic) and drops it after the session.  When not under
    xdist, creates/drops tables using the base agm_test DB as before.
    """
    worker_id = os.environ.get("PYTEST_XDIST_WORKER")
    worker_url = _worker_db_url()

    if worker_id is not None:
        # --- xdist mode: create a fresh per-worker database ---
        db_name = f"agm_test_{worker_id}"
        admin_url = _plain_url(_admin_url())

        # Create the worker DB (connect to postgres to issue CREATE DATABASE)
        conn = await asyncpg.connect(admin_url)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
            await conn.execute(f'CREATE DATABASE "{db_name}"')
        finally:
            await conn.close()

        # Run alembic migrations against the worker DB
        import subprocess, sys  # noqa: E401
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "alembic",
                "-x",
                f"dburl={worker_url}",
                "upgrade",
                "head",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:  # pragma: no cover — only fails if migrations are broken
            raise RuntimeError(
                f"Alembic migration failed for {db_name}:\n{result.stderr}"
            )

        engine = create_async_engine(worker_url, echo=False, future=True)
        yield engine
        await engine.dispose()

        # Drop the per-worker DB after the session
        conn = await asyncpg.connect(admin_url)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
        finally:
            await conn.close()
    else:
        # --- Non-xdist mode: use metadata create_all as before ---
        engine = create_async_engine(
            worker_url,
            echo=False,
            future=True,
        )
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield engine
        await engine.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def db_conn(test_engine) -> AsyncGenerator[AsyncConnection, None]:
    """
    Provide a connection with a savepoint so each test can roll back
    to a clean state without recreating tables.
    """
    async with test_engine.connect() as conn:
        await conn.begin()
        await conn.begin_nested()
        yield conn
        await conn.rollback()


@pytest_asyncio.fixture(loop_scope="session")
async def db_session(db_conn: AsyncConnection) -> AsyncGenerator[AsyncSession, None]:
    """
    Provide an AsyncSession bound to the per-test connection so that
    all DB operations in a test share the same transaction.
    """
    session_factory = async_sessionmaker(
        bind=db_conn,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    async with session_factory() as session:
        yield session


@pytest.fixture
def app(db_session: AsyncSession):
    """
    Create a FastAPI app instance with the get_db dependency overridden to use
    the test session so all HTTP requests share the same transaction.
    Also bypasses admin authentication so tests do not need to log in.
    """
    from app.main import create_app
    from app.routers.admin_auth import require_admin

    application = create_app()

    async def override_get_db():
        yield db_session

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[require_admin] = lambda: None
    yield application
    application.dependency_overrides.clear()
