"""
Tests for app.config, app.database, and app.main modules.

These tests exercise the module-level code (settings loading, engine creation,
FastAPI app factory, and the health endpoint) to satisfy 100% coverage.
"""
import asyncio
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
        """ENV=production + TESTING_MODE=false + strong secrets is allowed."""
        from app.config import Settings

        # Production requires a strong session_secret (>=32 chars) and bcrypt admin_password
        s = Settings(
            environment="production",
            testing_mode=False,
            session_secret="a" * 32,
            admin_password="$2b$12$examplehashforproductiontestAAAAAAAAAA",
        )
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
        """Verify the engine is configured with serverless-appropriate pool settings (RR3-05)."""
        from app.database import engine

        pool = engine.pool
        # NullPool is used in some test configurations and has no size() method.
        if hasattr(pool, "size"):
            assert pool.size() == 1

    def test_config_pool_settings_defaults(self):
        """DB pool settings have correct serverless Lambda defaults (RR3-05).

        pool_size=1: each Lambda instance holds at most 1 persistent connection.
        max_overflow=0: no burst connections — Lambda serves one request at a time.
        """
        from app.config import settings

        assert settings.db_pool_size == 1
        assert settings.db_max_overflow == 0
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

    async def test_security_middleware_catches_unhandled_exception_returns_500(self):
        """Unhandled exceptions return 500 {"detail": "An internal error occurred"} (RR3-11).

        SecurityHeadersMiddleware catches unhandled exceptions from route handlers
        and returns a safe generic 500 response to prevent raw error details reaching
        the client.  Tests by registering a temporary route that raises an unhandled exception.
        """
        from app.main import create_app

        app_instance = create_app()

        # Register a temporary test endpoint that raises an unhandled exception
        @app_instance.get("/api/test-unhandled-exception-rr311")
        async def raise_unhandled():
            raise RuntimeError("internal explosion — must not reach client")

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as client:
            response = await client.get("/api/test-unhandled-exception-rr311")
        assert response.status_code == 500
        data = response.json()
        assert data["detail"] == "An internal error occurred"
        # Raw exception message must NOT appear in the response body
        assert "explosion" not in response.text

    async def test_global_exception_handler_function_directly(self):
        """global_exception_handler returns 500 with generic message when called directly (RR3-11).

        Tests the @app.exception_handler(Exception) registration which acts as a
        belt-and-suspenders fallback when exceptions bypass SecurityHeadersMiddleware.
        """
        from unittest.mock import MagicMock
        from fastapi.responses import JSONResponse
        from app.main import create_app

        app_instance = create_app()

        # Find the global_exception_handler from the exception handlers
        # and invoke it directly to exercise lines 114-115
        handler = app_instance.exception_handlers.get(Exception)
        assert handler is not None, "global_exception_handler must be registered"

        mock_request = MagicMock()
        exc = RuntimeError("direct call test — must not reach client")

        response = await handler(mock_request, exc)
        assert isinstance(response, JSONResponse)
        assert response.status_code == 500
        import json
        body = json.loads(response.body)
        assert body["detail"] == "An internal error occurred"

    async def test_global_exception_handler_does_not_catch_http_exception(self):
        """HTTPException is not swallowed by the security middleware (RR3-11).

        FastAPI processes HTTPException before it reaches the middleware, so existing
        4xx/5xx HTTP responses from route handlers are unaffected.
        """
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            # /api/nonexistent-endpoint raises 404 HTTPException, not a generic 500
            response = await client.get("/api/nonexistent-xyz-endpoint")
        assert response.status_code == 404

    async def test_request_id_header_present_on_response(self):
        """RR3-38: Every response includes X-Request-ID header with a UUID value."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            response = await client.get("/api/health/live")
        assert response.status_code == 200
        assert "X-Request-ID" in response.headers
        # Should be a valid UUID
        import uuid as _uuid
        _uuid.UUID(response.headers["X-Request-ID"])  # raises ValueError if not UUID

    async def test_csrf_middleware_blocks_post_without_header(self):
        """US-IAS-05: POST without X-Requested-With returns 403 when testing_mode=False."""
        import app.main as main_module
        from app.config import Settings
        from app.main import create_app

        # Temporarily disable testing_mode to exercise CSRF enforcement.
        # conftest.py sets TESTING_MODE=true for all other tests; this test
        # explicitly overrides it to verify CSRF is enforced in production mode.
        prod_settings = Settings(testing_mode=False)
        csrf_app = create_app()
        original_settings = main_module.settings
        main_module.settings = prod_settings
        try:
            async with AsyncClient(
                transport=ASGITransport(app=csrf_app), base_url="http://test"
                # Intentionally no X-Requested-With header
            ) as client:
                response = await client.post("/api/auth/verify", json={})
            assert response.status_code == 403
            assert "CSRF" in response.json()["detail"]
        finally:
            main_module.settings = original_settings

    async def test_csrf_middleware_allows_post_with_header_in_production_mode(self):
        """US-IAS-05: POST with X-Requested-With passes through CSRF when testing_mode=False."""
        import app.main as main_module
        from app.config import Settings
        from app.main import create_app

        prod_settings = Settings(testing_mode=False)
        csrf_app = create_app()
        original_settings = main_module.settings
        main_module.settings = prod_settings
        try:
            async with AsyncClient(
                transport=ASGITransport(app=csrf_app), base_url="http://test",
                headers={"X-Requested-With": "XMLHttpRequest"},
            ) as client:
                response = await client.post("/api/auth/verify", json={})
            # 422 means the request passed CSRF and reached the route handler
            assert response.status_code == 422
        finally:
            main_module.settings = original_settings

    async def test_csrf_middleware_allows_post_with_header(self):
        """US-IAS-05: POST with X-Requested-With is passed through to the route handler."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test",
            headers={"X-Requested-With": "XMLHttpRequest"},
        ) as client:
            # /api/auth/verify with a bad payload will return 422 (not 403 from CSRF)
            response = await client.post("/api/auth/verify", json={})
        # A 422 (validation error) means the request passed CSRF and reached the route
        assert response.status_code == 422

    async def test_csrf_middleware_allows_get(self):
        """US-IAS-05: GET requests are not subject to CSRF check."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
            # Intentionally no X-Requested-With header on GET
        ) as client:
            response = await client.get("/api/health/live")
        assert response.status_code == 200

    async def test_csrf_middleware_exempts_admin_login(self):
        """US-IAS-05: Admin login endpoint is exempt from CSRF check."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
            # Intentionally no X-Requested-With header
        ) as client:
            response = await client.post("/api/admin/auth/login", json={"username": "x", "password": "y"})
        # Should reach the route handler (not blocked by CSRF) — returns 500 due to unhashed password
        # config, but NOT a 403 CSRF error
        assert response.status_code != 403

    def test_csrf_middleware_present(self):
        """US-IAS-05: CSRFMiddleware is registered in the app middleware stack."""
        from app.main import CSRFMiddleware, app

        middleware_classes = [m.cls for m in app.user_middleware if hasattr(m, "cls")]
        assert CSRFMiddleware in middleware_classes


# ---------------------------------------------------------------------------
# app.config — RR3-17: admin_password bcrypt format validator
# ---------------------------------------------------------------------------


class TestAdminPasswordValidator:
    # --- Happy path ---

    def test_bcrypt_hash_starting_with_2b_is_accepted(self):
        """ADMIN_PASSWORD starting with $2b$ is a valid bcrypt hash and must be accepted."""
        from pydantic import ValidationError
        from app.config import Settings

        # A real bcrypt hash starts with $2b$
        s = Settings(admin_password="$2b$12$abcdefghijklmnopqrstuvuPQRSTUVWXYZ0123456789ABCDEFGHIJKL")
        assert s.admin_password.startswith("$2b$")

    def test_bcrypt_hash_starting_with_2a_is_accepted(self):
        """ADMIN_PASSWORD starting with $2a$ (older bcrypt variant) is also accepted."""
        from app.config import Settings

        s = Settings(admin_password="$2a$12$abcdefghijklmnopqrstuvuPQRSTUVWXYZ0123456789ABCDEFGHIJKL")
        assert s.admin_password.startswith("$2a$")

    def test_dev_placeholder_admin_is_accepted(self):
        """The dev-only placeholder 'admin' is accepted (allows local dev and CI to work)."""
        from app.config import Settings

        s = Settings(admin_password="admin")
        assert s.admin_password == "admin"

    # --- State / precondition errors ---

    def test_plaintext_password_raises_value_error(self):
        """A plaintext password that is not a bcrypt hash raises ValueError at startup (RR3-17)."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(admin_password="mysecretpassword")
        assert "bcrypt hash" in str(exc_info.value).lower() or "$2b$" in str(exc_info.value)

    def test_empty_admin_password_is_accepted(self):
        """Empty ADMIN_PASSWORD is allowed (e.g. unconfigured env — caught at runtime login)."""
        from app.config import Settings

        s = Settings(admin_password="")
        assert s.admin_password == ""

    # --- Boundary values ---

    def test_password_starting_with_wrong_prefix_rejected(self):
        """A value that looks like a hash but has wrong prefix is rejected."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError):
            Settings(admin_password="$1$md5hashedvalue")

    def test_random_string_rejected(self):
        """A random non-bcrypt string other than 'admin' is rejected."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError):
            Settings(admin_password="changeme")


# ---------------------------------------------------------------------------
# app.config — RR3-35: Reject weak SESSION_SECRET and admin_password outside development
# ---------------------------------------------------------------------------


class TestWeakSecretsValidator:
    """Tests for reject_weak_secrets_outside_development validator (RR3-35)."""

    _STRONG_SECRET = "a" * 32
    _BCRYPT_HASH = "$2b$12$examplehashforproductiontestAAAAAAAAAA"

    # --- Happy path (development) ---

    def test_development_allows_weak_session_secret(self):
        """In development, the default weak session_secret is accepted."""
        from app.config import Settings

        s = Settings(environment="development", session_secret="change_me_to_a_random_secret")
        assert s.session_secret == "change_me_to_a_random_secret"

    def test_development_allows_admin_password(self):
        """In development, the default 'admin' password is accepted."""
        from app.config import Settings

        s = Settings(environment="development", admin_password="admin")
        assert s.admin_password == "admin"

    def test_production_with_strong_secrets_starts_ok(self):
        """Production environment with strong secrets starts without error."""
        from app.config import Settings

        s = Settings(
            environment="production",
            testing_mode=False,
            session_secret=self._STRONG_SECRET,
            admin_password=self._BCRYPT_HASH,
        )
        assert s.environment == "production"

    def test_preview_with_strong_secrets_starts_ok(self):
        """Preview environment with strong secrets starts without error."""
        from app.config import Settings

        s = Settings(
            environment="preview",
            testing_mode=False,
            session_secret=self._STRONG_SECRET,
            admin_password=self._BCRYPT_HASH,
        )
        assert s.environment == "preview"

    # --- State / precondition errors ---

    def test_production_with_weak_session_secret_raises(self):
        """Production rejects the default weak SESSION_SECRET."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(
                environment="production",
                testing_mode=False,
                session_secret="change_me_to_a_random_secret",
                admin_password=self._BCRYPT_HASH,
            )
        assert "SESSION_SECRET is too weak" in str(exc_info.value)

    def test_production_with_short_session_secret_raises(self):
        """Production rejects a session_secret shorter than 32 characters."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(
                environment="production",
                testing_mode=False,
                session_secret="short",
                admin_password=self._BCRYPT_HASH,
            )
        assert "SESSION_SECRET is too weak" in str(exc_info.value)

    def test_preview_with_weak_session_secret_raises(self):
        """Preview environment also rejects weak SESSION_SECRET."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(
                environment="preview",
                testing_mode=False,
                session_secret="change_me_to_a_random_secret",
                admin_password=self._BCRYPT_HASH,
            )
        assert "SESSION_SECRET is too weak" in str(exc_info.value)

    def test_production_with_dev_admin_password_raises(self):
        """Production rejects the 'admin' placeholder password."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(
                environment="production",
                testing_mode=False,
                session_secret=self._STRONG_SECRET,
                admin_password="admin",
            )
        assert "ADMIN_PASSWORD must be a bcrypt hash" in str(exc_info.value)

    def test_session_secret_exactly_32_chars_is_accepted(self):
        """A session_secret of exactly 32 characters is accepted in non-development."""
        from app.config import Settings

        s = Settings(
            environment="production",
            testing_mode=False,
            session_secret="a" * 32,
            admin_password=self._BCRYPT_HASH,
        )
        assert len(s.session_secret) == 32

    def test_auth_service_token_max_age_matches_session_duration(self):
        """_TOKEN_MAX_AGE_SECONDS equals SESSION_DURATION in seconds (RR3-36)."""
        from app.services.auth_service import _TOKEN_MAX_AGE_SECONDS, SESSION_DURATION

        assert _TOKEN_MAX_AGE_SECONDS == int(SESSION_DURATION.total_seconds())
        assert _TOKEN_MAX_AGE_SECONDS == 1800


# ---------------------------------------------------------------------------
# app.config — RR3-23: DATABASE_URL validation
# ---------------------------------------------------------------------------


class TestDatabaseUrlValidator:
    def test_valid_asyncpg_url_accepted(self):
        """A postgresql+asyncpg:// URL is accepted without error."""
        from app.config import Settings

        s = Settings(database_url="postgresql+asyncpg://user:pass@localhost:5432/db")
        assert s.database_url.startswith("postgresql+asyncpg://")

    def test_empty_url_rejected(self):
        """An empty DATABASE_URL is rejected with a clear error (RR3-23)."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(database_url="")
        assert "DATABASE_URL must not be empty" in str(exc_info.value)

    def test_plain_postgresql_url_rejected(self):
        """A postgresql:// URL (without +asyncpg) is rejected (RR3-23)."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(database_url="postgresql://user:pass@localhost/db")
        assert "postgresql+asyncpg://" in str(exc_info.value)

    def test_sqlite_url_rejected(self):
        """A sqlite:// URL is rejected (RR3-23)."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(database_url="sqlite:///test.db")
        assert "postgresql+asyncpg://" in str(exc_info.value)

    def test_channel_binding_rejected(self):
        """A URL containing channel_binding is rejected (RR3-23)."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(database_url="postgresql+asyncpg://user:pass@host/db?channel_binding=require")
        assert "channel_binding" in str(exc_info.value)

    def test_sslmode_rejected(self):
        """A URL using sslmode= instead of ssl= is rejected (RR3-23)."""
        from pydantic import ValidationError
        from app.config import Settings

        with pytest.raises(ValidationError) as exc_info:
            Settings(database_url="postgresql+asyncpg://user:pass@host/db?sslmode=require")
        assert "sslmode=" in str(exc_info.value)


# ---------------------------------------------------------------------------
# app.main — RR3-20: migration head check
# ---------------------------------------------------------------------------


class TestMigrationHeadCheck:
    async def test_check_migration_head_ok_logs_info(self):
        """_check_migration_head logs migration_head_ok when revision matches head."""
        import app.main as main_module
        import structlog.testing
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.main import _check_migration_head

        mock_head = "abc123"
        mock_row = MagicMock()
        mock_row.__getitem__ = lambda self, idx: mock_head

        mock_result = MagicMock()
        mock_result.first.return_value = mock_row

        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        mock_session_local = MagicMock(return_value=mock_session_ctx)

        mock_script = MagicMock()
        mock_script.get_current_head.return_value = mock_head

        # RR4-34: Reset the module-level cache so the DB query actually runs.
        original_checked = main_module._migration_head_checked
        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_checked = False
        main_module._migration_head_mismatch = False
        try:
            # The function imports AsyncSessionLocal locally from app.database; patch there.
            with (
                patch("app.database.AsyncSessionLocal", mock_session_local),
                patch("alembic.script.ScriptDirectory.from_config", return_value=mock_script),
            ):
                with structlog.testing.capture_logs() as logs:
                    await _check_migration_head()
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

        info_logs = [l for l in logs if l.get("log_level") == "info"]
        assert any("migration_head_ok" in str(l) for l in info_logs)

    async def test_check_migration_head_mismatch_logs_critical_and_raises(self):
        """RR4-16: _check_migration_head logs critical and raises RuntimeError on mismatch."""
        import app.main as main_module
        import structlog.testing
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.main import _check_migration_head

        mock_head = "abc123"
        mock_current = "old456"
        mock_row = MagicMock()
        mock_row.__getitem__ = lambda self, idx: mock_current

        mock_result = MagicMock()
        mock_result.first.return_value = mock_row

        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        mock_session_local = MagicMock(return_value=mock_session_ctx)

        mock_script = MagicMock()
        mock_script.get_current_head.return_value = mock_head

        # RR4-34: Reset cache so the DB query runs.
        original_checked = main_module._migration_head_checked
        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_checked = False
        main_module._migration_head_mismatch = False
        try:
            with (
                patch("app.database.AsyncSessionLocal", mock_session_local),
                patch("alembic.script.ScriptDirectory.from_config", return_value=mock_script),
            ):
                with structlog.testing.capture_logs() as logs:
                    with pytest.raises(RuntimeError, match="Migration head mismatch"):
                        await _check_migration_head()
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

        critical_logs = [l for l in logs if l.get("log_level") == "critical"]
        assert any("migration_head_mismatch" in str(l) for l in critical_logs)

    async def test_check_migration_head_exception_logs_error(self):
        """_check_migration_head logs error when an exception occurs."""
        import app.main as main_module
        import structlog.testing
        from unittest.mock import patch

        from app.main import _check_migration_head

        # RR4-34: Reset cache so the function actually runs.
        original_checked = main_module._migration_head_checked
        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_checked = False
        main_module._migration_head_mismatch = False
        try:
            with patch(
                "alembic.script.ScriptDirectory.from_config",
                side_effect=Exception("alembic config not found"),
            ):
                with structlog.testing.capture_logs() as logs:
                    await _check_migration_head()
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

        error_logs = [l for l in logs if l.get("log_level") in ("error", "warning")]
        assert any("migration_head_check_failed" in str(l) for l in error_logs)

    async def test_check_migration_head_no_revision_row(self):
        """RR4-16: _check_migration_head raises RuntimeError when alembic_version row missing."""
        import app.main as main_module
        import structlog.testing
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.main import _check_migration_head

        mock_head = "abc123"
        mock_result = MagicMock()
        mock_result.first.return_value = None  # no alembic_version row

        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)

        mock_session_local = MagicMock(return_value=mock_session_ctx)

        mock_script = MagicMock()
        mock_script.get_current_head.return_value = mock_head

        # RR4-34: Reset cache so the DB query runs.
        original_checked = main_module._migration_head_checked
        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_checked = False
        main_module._migration_head_mismatch = False
        try:
            with (
                patch("app.database.AsyncSessionLocal", mock_session_local),
                patch("alembic.script.ScriptDirectory.from_config", return_value=mock_script),
            ):
                with structlog.testing.capture_logs() as logs:
                    # current_rev is None, head is "abc123" — mismatch, should raise
                    with pytest.raises(RuntimeError, match="Migration head mismatch"):
                        await _check_migration_head()
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

        critical_logs = [l for l in logs if l.get("log_level") == "critical"]
        assert any("migration_head_mismatch" in str(l) for l in critical_logs)

    async def test_check_migration_head_cache_skips_db_on_second_call(self):
        """RR4-34: _check_migration_head only queries DB once; warm invocations are no-ops."""
        import app.main as main_module
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.main import _check_migration_head

        mock_head = "abc123"
        mock_row = MagicMock()
        mock_row.__getitem__ = lambda self, idx: mock_head
        mock_result = MagicMock()
        mock_result.first.return_value = mock_row
        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)
        mock_script = MagicMock()
        mock_script.get_current_head.return_value = mock_head

        # RR4-34: Reset cache for first call.
        original_checked = main_module._migration_head_checked
        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_checked = False
        main_module._migration_head_mismatch = False
        try:
            with (
                patch("app.database.AsyncSessionLocal", mock_session_local),
                patch("alembic.script.ScriptDirectory.from_config", return_value=mock_script),
            ):
                # First call: queries DB
                await _check_migration_head()
                assert mock_db.execute.call_count == 1

                # Second call: _migration_head_checked=True, DB must NOT be queried again
                await _check_migration_head()
                assert mock_db.execute.call_count == 1, "DB should not be queried on second call"
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

    async def test_migration_mismatch_returns_503_on_requests(self):
        """RR4-16: When migration mismatch detected, all routes return 503."""
        import app.main as main_module
        from app.main import app

        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_mismatch = True
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/api/health")
            assert response.status_code == 503
            assert "migration" in response.json()["detail"].lower()
        finally:
            main_module._migration_head_mismatch = original_mismatch

    async def test_migration_mismatch_allows_health_live(self):
        """RR4-16: health/live probe still returns 200 even when migration mismatch detected."""
        import app.main as main_module
        from app.main import app

        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_mismatch = True
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/api/health/live")
            assert response.status_code == 200
        finally:
            main_module._migration_head_mismatch = original_mismatch
