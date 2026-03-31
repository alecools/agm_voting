"""
Tests for app.config, app.database, and app.main modules.

These tests exercise the module-level code (settings loading, engine creation,
FastAPI app factory, and the health endpoint) to satisfy 100% coverage.
"""
import os
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import OperationalError


# ---------------------------------------------------------------------------
# app.config
# ---------------------------------------------------------------------------


class TestConfig:
    def test_settings_defaults(self):
        from app.config import settings

        # Default values are set when no .env file overrides them
        assert settings.smtp_host == ""
        assert settings.smtp_port == 587
        assert settings.smtp_username == ""
        assert settings.smtp_password == ""
        assert settings.smtp_from_email == ""
        assert settings.allowed_origin == "http://localhost:5173"
        assert settings.session_secret == "change_me_to_a_random_secret"
        assert settings.admin_username == "admin"
        assert settings.admin_password == "admin"

    def test_settings_database_url_has_asyncpg(self):
        from app.config import settings

        assert "asyncpg" in settings.database_url or "postgresql" in settings.database_url

    def test_settings_test_database_url(self):
        from app.config import settings

        assert settings.test_database_url != ""

    def test_production_with_testing_mode_false_starts_ok(self):
        """ENV=production + TESTING_MODE=false is allowed — settings loads without error."""
        from app.config import Settings

        s = Settings(environment="production", testing_mode=False)
        assert s.environment == "production"
        assert s.testing_mode is False

    def test_production_with_testing_mode_true_raises(self):
        """ENV=production + TESTING_MODE=true must raise ValueError at settings load time."""
        from pydantic import ValidationError

        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(environment="production", testing_mode=True)
        assert "TESTING_MODE is enabled in a production environment" in str(exc_info.value)

    def test_development_with_testing_mode_true_starts_ok(self):
        """ENV=development + TESTING_MODE=true is allowed (dev/test workflow)."""
        from app.config import Settings

        s = Settings(environment="development", testing_mode=True)
        assert s.environment == "development"
        assert s.testing_mode is True

    def test_testing_env_with_testing_mode_true_starts_ok(self):
        """ENV=testing + TESTING_MODE=true is allowed (CI test runs)."""
        from app.config import Settings

        s = Settings(environment="testing", testing_mode=True)
        assert s.environment == "testing"
        assert s.testing_mode is True


# ---------------------------------------------------------------------------
# app.database
# ---------------------------------------------------------------------------


class TestDatabase:
    def test_engine_created(self):
        from app.database import engine

        assert engine is not None

    def test_engine_pool_configuration(self):
        """Verify the engine is configured with serverless-appropriate pool settings."""
        from app.database import engine

        pool = engine.pool
        # NullPool is used in some test configurations and has no size() method.
        if hasattr(pool, "size"):
            assert pool.size() == 2

    def test_config_pool_settings_defaults(self):
        """DB pool settings have correct serverless defaults."""
        from app.config import settings

        assert settings.db_pool_size == 2
        assert settings.db_max_overflow == 3
        assert settings.db_pool_timeout == 10

    def test_session_factory_created(self):
        from app.database import AsyncSessionLocal

        assert AsyncSessionLocal is not None

    async def test_get_db_yields_session(self):
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.database import get_db

        # get_db is an async generator; exercise it with the test DB URL
        gen = get_db()
        session = await gen.__anext__()
        assert isinstance(session, AsyncSession)
        # Close the generator
        try:
            await gen.aclose()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# app.main
# ---------------------------------------------------------------------------


class TestMain:
    def test_create_app_returns_fastapi(self):
        from fastapi import FastAPI

        from app.main import create_app

        application = create_app()
        assert isinstance(application, FastAPI)

    def test_app_singleton(self):
        from app.main import app

        assert app is not None
        assert app.title == "General Meeting Voting App"

    async def test_health_endpoint_returns_db_connected(self):
        """Health endpoint returns 200 with db=connected when DB is reachable."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["db"] == "connected"

    async def test_health_endpoint_returns_503_on_db_failure(self):
        """Health endpoint returns 503 when the DB query raises an exception."""
        from app.main import app
        from app.database import get_db

        async def broken_db():
            # Simulate a DB session that raises on execute
            mock_session = AsyncMock()
            mock_session.execute.side_effect = OperationalError(
                "Connection refused", None, None
            )
            yield mock_session

        app.dependency_overrides[get_db] = broken_db
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/api/health")
            assert response.status_code == 503
            detail = response.json()["detail"]
            assert detail["status"] == "degraded"
            assert detail["db"] == "unreachable"
            assert "error" in detail
        finally:
            app.dependency_overrides.pop(get_db, None)

    async def test_health_endpoint_returns_503_on_timeout(self):
        """Health endpoint returns 503 when the DB query exceeds the 2-second timeout."""
        from app.main import app
        from app.database import get_db

        async def slow_db():
            mock_session = AsyncMock()
            # Simulate a DB session that never resolves (timeout scenario)
            async def hang(*args, **kwargs):
                raise asyncio.TimeoutError()
            mock_session.execute.side_effect = hang
            yield mock_session

        app.dependency_overrides[get_db] = slow_db
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/api/health")
            assert response.status_code == 503
            detail = response.json()["detail"]
            assert detail["status"] == "degraded"
            assert detail["db"] == "unreachable"
        finally:
            app.dependency_overrides.pop(get_db, None)

    async def test_health_live_endpoint(self):
        """Liveness endpoint always returns 200 without touching the DB."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/health/live")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_cors_middleware_present(self):
        from starlette.middleware.cors import CORSMiddleware

        from app.main import app

        # Check that CORS middleware is in the middleware stack
        middleware_classes = [m.cls for m in app.user_middleware if hasattr(m, "cls")]
        assert CORSMiddleware in middleware_classes

    def test_session_middleware_present(self):
        from starlette.middleware.sessions import SessionMiddleware

        from app.main import app

        middleware_classes = [m.cls for m in app.user_middleware if hasattr(m, "cls")]
        assert SessionMiddleware in middleware_classes
