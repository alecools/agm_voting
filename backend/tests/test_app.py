"""
Tests for app.config, app.database, and app.main modules.

These tests exercise the module-level code (settings loading, engine creation,
FastAPI app factory, and the health endpoint) to satisfy 100% coverage.
"""
import os

import pytest
from httpx import ASGITransport, AsyncClient


# ---------------------------------------------------------------------------
# app.config
# ---------------------------------------------------------------------------


class TestConfig:
    def test_settings_defaults(self):
        from app.config import settings

        # Default values are set when no .env file overrides them
        assert settings.resend_from_email == "noreply@example.com"
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


# ---------------------------------------------------------------------------
# app.database
# ---------------------------------------------------------------------------


class TestDatabase:
    def test_engine_created(self):
        from app.database import engine

        assert engine is not None

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
        assert app.title == "AGM Voting App"

    async def test_health_endpoint(self):
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/health")
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
