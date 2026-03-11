"""
Pytest configuration and fixtures for backend tests.

Uses the TEST_DATABASE_URL from environment (or a default) with isolated
transactions per test for complete isolation.

All async fixtures and tests run in a single session-scoped event loop so that
the asyncpg connection pool is not attached to a different loop than the tests.
"""
import os
from collections.abc import AsyncGenerator

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
TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test",
)


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def test_engine():
    """Create an async engine for the test session."""
    engine = create_async_engine(
        TEST_DATABASE_URL,
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
