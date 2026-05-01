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
        assert settings.neon_auth_base_url == ""

    def test_settings_database_url_has_asyncpg(self):
        from app.config import settings

        assert "asyncpg" in settings.database_url or "postgresql" in settings.database_url

    def test_settings_test_database_url(self):
        from app.config import settings

        assert settings.test_database_url != ""

    def test_production_with_testing_mode_false_starts_ok(self):
        """ENV=production + TESTING_MODE=false + strong secrets is allowed."""
        from app.config import Settings

        # Production requires a strong session_secret (>=32 chars)
        s = Settings(
            environment="production",
            testing_mode=False,
            session_secret="a" * 32,
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

    def test_engine_uses_persistent_pool(self):
        """Verify the engine is configured with a QueuePool sized for Fluid Compute concurrency."""
        from sqlalchemy.pool import QueuePool

        from app.database import engine

        assert isinstance(engine.pool, QueuePool)
        assert engine.pool.size() == 20

    def test_engine_connect_args(self):
        """Engine connect_args enables statement cache (direct Neon connection) and sets asyncpg timeout.

        With DATABASE_URL_UNPOOLED (direct endpoint, no PgBouncer), statement_cache_size=100
        allows asyncpg to cache prepared statements per connection. This eliminates per-query
        type introspection — the root cause of OutOfMemoryError under concurrent E2E load.

        SQLAlchemy merges connect_args into the asyncpg connection parameters dict, which
        is stored as a closure variable in the pool's creator function. We extract it from
        there to verify both required keys are present with the expected values.
        """
        from app.database import engine

        # The pool creator closes over (cargs_tup, cparams) produced by
        # dialect.create_connect_args(). The merged keyword params dict is an
        # immutabledict that contains both dialect-level URL params and any extra
        # connect_args passed to create_async_engine().
        creator = engine.pool._creator
        cparams: dict = {}
        if creator.__closure__:
            for cell in creator.__closure__:
                try:
                    val = cell.cell_contents
                    if isinstance(val, dict) and "statement_cache_size" in val:
                        cparams = dict(val)
                        break
                except ValueError:
                    pass

        assert cparams.get("statement_cache_size") == 100, (
            "statement_cache_size must be 100 for direct Neon connection — "
            "eliminates per-query type introspection and prevents OutOfMemoryError"
        )
        assert cparams.get("timeout") == 5, (
            "timeout must be 5 so asyncpg raises after 5s during Neon wake-up "
            "instead of hanging indefinitely"
        )

    def test_session_factory_created(self):
        from app.database import AsyncSessionLocal

        assert AsyncSessionLocal is not None

    def test_engine_url_uses_database_url_unpooled_when_set(self):
        """_engine_url prefers DATABASE_URL_UNPOOLED over settings.database_url when set.

        The Neon-Vercel integration injects DATABASE_URL_UNPOOLED pointing to the direct
        endpoint (no PgBouncer). Using it enables statement caching and prevents OOM errors.
        """
        import importlib
        import sys
        import os
        from unittest.mock import patch

        direct_url = "postgresql+asyncpg://user:pass@direct.neon.tech/db?ssl=require"
        # Temporarily remove the cached module so it can be re-imported with the env var set.
        saved = sys.modules.pop("app.database", None)
        try:
            with patch.dict(os.environ, {"DATABASE_URL_UNPOOLED": direct_url}):
                import app.database as db_module_fresh
                assert db_module_fresh._engine_url == direct_url
        finally:
            # Restore original module state
            sys.modules.pop("app.database", None)
            if saved is not None:
                sys.modules["app.database"] = saved

    def test_engine_url_falls_back_to_settings_when_unpooled_not_set(self):
        """_engine_url falls back to settings.database_url when DATABASE_URL_UNPOOLED is absent.

        In local development, DATABASE_URL_UNPOOLED is not set so the engine uses
        settings.database_url (the dev/test database URL).
        """
        import sys
        import os
        from unittest.mock import patch

        saved = sys.modules.pop("app.database", None)
        try:
            env_without_unpooled = {k: v for k, v in os.environ.items() if k != "DATABASE_URL_UNPOOLED"}
            with patch.dict(os.environ, env_without_unpooled, clear=True):
                import app.database as db_module_fresh
                from app.config import settings
                assert db_module_fresh._engine_url == settings.database_url
        finally:
            sys.modules.pop("app.database", None)
            if saved is not None:
                sys.modules["app.database"] = saved

    def test_engine_connect_args_timeout(self):
        """Engine connect_args has timeout=5 to detect hung Neon connections quickly.

        SQLAlchemy merges connect_args into the pool creator's closure (cparams).
        We inspect that closure to verify the timeout value — dialect.create_connect_args
        only returns driver defaults, not user-supplied overrides. The timeout guard is
        needed so asyncpg raises after 5s during Neon wake-up instead of hanging indefinitely.
        """
        import inspect

        from app.database import engine

        # The pool creator is a closure that captures `cparams` — the merged
        # connect kwargs including any user-supplied connect_args.
        pool_creator = engine.sync_engine.pool._creator
        cparams = inspect.getclosurevars(pool_creator).nonlocals.get("cparams", {})
        assert cparams.get("timeout") == 5

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

    # --- Retry logic ---

    async def test_get_db_retries_on_operational_error_then_succeeds(self):
        """get_db retries when OperationalError occurs on first attempt, then yields a session."""
        from unittest.mock import AsyncMock, MagicMock, patch
        from sqlalchemy.exc import OperationalError

        from app.database import get_db

        call_count = 0
        real_session = AsyncMock()

        async def flaky_session_cm():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise OperationalError("connection refused", None, None)
            # Second call succeeds — return a context manager yielding the mock session
            cm = AsyncMock()
            cm.__aenter__ = AsyncMock(return_value=real_session)
            cm.__aexit__ = AsyncMock(return_value=False)
            return cm

        with patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep, \
             patch("app.database.AsyncSessionLocal") as mock_factory:
            mock_factory.side_effect = lambda: flaky_session_cm().__await__()

            # Use a simpler approach: patch the context manager directly
            mock_factory.reset_mock()

            call_count = 0
            sessions_returned = []

            async def patched_factory():
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise OperationalError("connection refused", None, None)
                cm = MagicMock()
                cm.__aenter__ = AsyncMock(return_value=real_session)
                cm.__aexit__ = AsyncMock(return_value=False)
                return cm

            # Patch AsyncSessionLocal as a callable that returns an async context manager
            mock_factory.side_effect = None
            mock_factory.return_value = None

            call_count = 0

            class FlakySessionLocal:
                def __init__(self):
                    nonlocal call_count
                    call_count += 1
                    self._should_fail = (call_count == 1)

                async def __aenter__(self):
                    if self._should_fail:
                        raise OperationalError("connection refused", None, None)
                    return real_session

                async def __aexit__(self, *args):
                    return False

            with patch("app.database.AsyncSessionLocal", FlakySessionLocal), \
                 patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep2:
                gen = get_db()
                session = await gen.__anext__()
                assert session is real_session
                assert mock_sleep2.call_count == 1
                assert mock_sleep2.call_args[0][0] == 2  # waited 2s on first retry
                try:
                    await gen.aclose()
                except Exception:
                    pass

    async def test_get_db_retries_on_dbapi_error_then_succeeds(self):
        """get_db retries on DBAPIError (subclass of OperationalError) and eventually yields."""
        from unittest.mock import AsyncMock, MagicMock, patch
        from sqlalchemy.exc import DBAPIError

        from app.database import get_db

        real_session = AsyncMock()
        call_count = 0

        class FlakySessionLocal:
            def __init__(self):
                nonlocal call_count
                call_count += 1
                self._should_fail = (call_count == 1)

            async def __aenter__(self):
                if self._should_fail:
                    raise DBAPIError("db error", None, None)
                return real_session

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", FlakySessionLocal), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            session = await gen.__anext__()
            assert session is real_session
            assert mock_sleep.call_count == 1

    async def test_get_db_retries_on_sqlalchemy_timeout_error_then_succeeds(self):
        """get_db retries on SQLAlchemy TimeoutError (QueuePool exhaustion) and eventually yields."""
        from unittest.mock import AsyncMock, patch
        from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

        from app.database import get_db

        real_session = AsyncMock()
        call_count = 0

        class FlakySessionLocal:
            def __init__(self):
                nonlocal call_count
                call_count += 1
                self._should_fail = (call_count == 1)

            async def __aenter__(self):
                if self._should_fail:
                    raise SQLAlchemyTimeoutError("QueuePool limit exceeded", None, None)
                return real_session

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", FlakySessionLocal), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            session = await gen.__anext__()
            assert session is real_session
            assert mock_sleep.call_count == 1

    async def test_get_db_retries_on_asyncio_timeout_error_then_succeeds(self):
        """get_db retries on asyncio.TimeoutError (TCP connection timeout) and eventually yields."""
        from unittest.mock import AsyncMock, patch

        from app.database import get_db

        real_session = AsyncMock()
        call_count = 0

        class FlakySessionLocal:
            def __init__(self):
                nonlocal call_count
                call_count += 1
                self._should_fail = (call_count == 1)

            async def __aenter__(self):
                if self._should_fail:
                    raise asyncio.TimeoutError("TCP connection timeout")
                return real_session

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", FlakySessionLocal), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            session = await gen.__anext__()
            assert session is real_session
            assert mock_sleep.call_count == 1

    async def test_get_db_raises_after_all_retries_exhausted(self):
        """get_db raises the last OperationalError after _DB_RETRY_ATTEMPTS failures."""
        from unittest.mock import AsyncMock, patch
        from sqlalchemy.exc import OperationalError

        from app.database import get_db, _DB_RETRY_ATTEMPTS

        class AlwaysFailSessionLocal:
            async def __aenter__(self):
                raise OperationalError("persistent connection failure", None, None)

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", AlwaysFailSessionLocal), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            with pytest.raises(OperationalError):
                await gen.__anext__()
            # Slept between all retries except after the last one
            assert mock_sleep.call_count == _DB_RETRY_ATTEMPTS - 1

    async def test_get_db_exponential_backoff_wait_times(self):
        """get_db waits 2s, 4s, 8s, 16s between consecutive retries (exponential backoff)."""
        from unittest.mock import AsyncMock, patch
        from sqlalchemy.exc import OperationalError

        from app.database import get_db

        class AlwaysFailSessionLocal:
            async def __aenter__(self):
                raise OperationalError("timeout", None, None)

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", AlwaysFailSessionLocal), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            with pytest.raises(OperationalError):
                await gen.__anext__()

        wait_times = [call[0][0] for call in mock_sleep.call_args_list]
        assert wait_times == [2, 4, 8, 16], f"Expected [2, 4, 8, 16] wait times, got {wait_times}"

    async def test_get_db_no_sleep_on_non_connection_error(self):
        """get_db does NOT retry on non-transient errors (e.g. ValueError) — raises immediately."""
        from unittest.mock import AsyncMock, patch

        from app.database import get_db

        class FailWithValueError:
            async def __aenter__(self):
                raise ValueError("not a connection error")

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", FailWithValueError), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            with pytest.raises(ValueError):
                await gen.__anext__()
            # No sleep — we do not retry non-OperationalError / non-DBAPIError exceptions
            assert mock_sleep.call_count == 0

    async def test_get_db_succeeds_on_first_attempt_no_sleep(self):
        """get_db does not call asyncio.sleep when the first attempt succeeds."""
        from unittest.mock import AsyncMock, patch
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.database import get_db

        real_session = AsyncMock(spec=AsyncSession)

        class HappySessionLocal:
            async def __aenter__(self):
                return real_session

            async def __aexit__(self, *args):
                return False

        with patch("app.database.AsyncSessionLocal", HappySessionLocal), \
             patch("app.database.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            gen = get_db()
            session = await gen.__anext__()
            assert session is real_session
            assert mock_sleep.call_count == 0
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
        """US-IAS-05: POST without X-Requested-With returns 403 when testing_mode=False.

        Uses /api/admin/buildings (non-exempt path) to test CSRF enforcement.
        /api/auth/* paths are intentionally exempt because the Better Auth SDK
        does not send X-Requested-With.
        """
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
                # /api/admin/buildings is a non-exempt POST endpoint — CSRF must block it
                response = await client.post("/api/admin/buildings", json={})
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
        """US-IAS-05: Better Auth sign-in endpoint is exempt from CSRF check."""
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
            # Intentionally no X-Requested-With header
        ) as client:
            response = await client.post(
                "/api/auth/sign-in/email",
                json={"email": "x@example.com", "password": "y"},
            )
        # Should reach the route handler (not blocked by CSRF) — may return 404 since the
        # Better Auth proxy is not configured in tests, but NOT a 403 CSRF error
        assert response.status_code != 403

    def test_csrf_middleware_present(self):
        """US-IAS-05: CSRFMiddleware is registered in the app middleware stack."""
        from app.main import CSRFMiddleware, app

        middleware_classes = [m.cls for m in app.user_middleware if hasattr(m, "cls")]
        assert CSRFMiddleware in middleware_classes


# ---------------------------------------------------------------------------
# app.config — RR3-35: Reject weak SESSION_SECRET outside development
# ---------------------------------------------------------------------------


class TestWeakSecretsValidator:
    """Tests for reject_weak_secrets_outside_development validator (RR3-35)."""

    _STRONG_SECRET = "a" * 32

    # --- Happy path (development) ---

    def test_development_allows_weak_session_secret(self):
        """In development, the default weak session_secret is accepted."""
        from app.config import Settings

        s = Settings(environment="development", session_secret="change_me_to_a_random_secret")
        assert s.session_secret == "change_me_to_a_random_secret"

    def test_production_with_strong_secrets_starts_ok(self):
        """Production environment with strong session_secret starts without error."""
        from app.config import Settings

        s = Settings(
            environment="production",
            testing_mode=False,
            session_secret=self._STRONG_SECRET,
        )
        assert s.environment == "production"

    def test_preview_with_strong_secrets_starts_ok(self):
        """Preview environment with strong session_secret starts without error."""
        from app.config import Settings

        s = Settings(
            environment="preview",
            testing_mode=False,
            session_secret=self._STRONG_SECRET,
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
            )
        assert "SESSION_SECRET is too weak" in str(exc_info.value)

    def test_session_secret_exactly_32_chars_is_accepted(self):
        """A session_secret of exactly 32 characters is accepted in non-development."""
        from app.config import Settings

        s = Settings(
            environment="production",
            testing_mode=False,
            session_secret="a" * 32,
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
        assert not main_module._migration_head_mismatch, \
            "non-RuntimeError exceptions must not set _migration_head_mismatch to True"

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

    async def test_check_migration_head_logs_resolved_head_rev(self):
        """_check_migration_head logs migration_head_resolved with the resolved head_rev."""
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
                    await _check_migration_head()
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

        info_logs = [l for l in logs if l.get("log_level") == "info"]
        resolved_logs = [l for l in info_logs if l.get("event") == "migration_head_resolved"]
        assert resolved_logs, "migration_head_resolved info log must be emitted"
        assert resolved_logs[0]["head_rev"] == mock_head

    async def test_check_migration_head_none_head_rev_skips_check_no_mismatch(self):
        """When get_current_head() returns None, log a warning and skip mismatch check.

        In the Vercel Lambda environment, alembic script resolution may return None
        if __file__ resolves to a different path and alembic.ini is not found.
        The fix ensures _migration_head_mismatch is NOT set to True in this case,
        preventing all subsequent requests from returning 503.
        """
        import app.main as main_module
        import structlog.testing
        from unittest.mock import MagicMock, patch

        from app.main import _check_migration_head

        mock_script = MagicMock()
        mock_script.get_current_head.return_value = None  # Simulate Lambda path resolution failure

        original_checked = main_module._migration_head_checked
        original_mismatch = main_module._migration_head_mismatch
        main_module._migration_head_checked = False
        main_module._migration_head_mismatch = False
        try:
            with (
                patch("alembic.script.ScriptDirectory.from_config", return_value=mock_script),
            ):
                with structlog.testing.capture_logs() as logs:
                    await _check_migration_head()

            # Must NOT have set the mismatch flag
            assert main_module._migration_head_mismatch is False, (
                "None head_rev must not set _migration_head_mismatch — "
                "treat as 'skip check, not a mismatch'"
            )
        finally:
            main_module._migration_head_checked = original_checked
            main_module._migration_head_mismatch = original_mismatch

        # Must log a warning indicating the check was skipped
        warning_logs = [l for l in logs if l.get("log_level") == "warning"]
        assert any("migration_head_resolution_failed" in str(l) for l in warning_logs), (
            "migration_head_resolution_failed warning must be emitted when head_rev is None"
        )


# ---------------------------------------------------------------------------
# app.main — lifespan: sequential startup DB operations
# ---------------------------------------------------------------------------


class TestLifespan:
    """Verify that startup DB operations run sequentially, not concurrently.

    If _check_migration_head() and requeue_pending_on_startup() were run
    concurrently (e.g. via asyncio.gather), both would race for the single
    pooled connection and the startup sequence would be non-deterministic.
    Sequential awaits ensure each operation acquires, uses, and releases its
    connection before the next one starts.
    """

    # --- Happy path ---

    async def test_lifespan_runs_check_then_requeue_sequentially(self):
        """Lifespan awaits _check_migration_head then requeue_pending_on_startup in order."""
        from unittest.mock import AsyncMock, MagicMock, patch, call
        from fastapi import FastAPI
        from app.main import lifespan

        call_order = []

        async def mock_check_migration_head():
            call_order.append("check_migration_head")

        mock_email_service = MagicMock()
        mock_email_service.requeue_pending_on_startup = AsyncMock(
            side_effect=lambda db: call_order.append("requeue_pending_on_startup")
        )

        mock_db = AsyncMock()
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)

        with (
            patch("app.main._check_migration_head", mock_check_migration_head),
            patch("app.database.AsyncSessionLocal", mock_session_local),
            patch("app.services.email_service.EmailService", return_value=mock_email_service),
        ):
            app_instance = FastAPI()
            async with lifespan(app_instance):
                pass  # just exercise startup

        assert call_order == ["check_migration_head", "requeue_pending_on_startup"], (
            "startup operations must run sequentially: check_migration_head first, "
            "then requeue_pending_on_startup"
        )

    async def test_lifespan_check_migration_head_called_once(self):
        """_check_migration_head is called exactly once during lifespan startup."""
        from unittest.mock import AsyncMock, MagicMock, patch
        from fastapi import FastAPI
        from app.main import lifespan

        mock_check = AsyncMock()
        mock_email_service = MagicMock()
        mock_email_service.requeue_pending_on_startup = AsyncMock()

        mock_db = AsyncMock()
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)

        with (
            patch("app.main._check_migration_head", mock_check),
            patch("app.database.AsyncSessionLocal", mock_session_local),
            patch("app.services.email_service.EmailService", return_value=mock_email_service),
        ):
            app_instance = FastAPI()
            async with lifespan(app_instance):
                pass

        mock_check.assert_awaited_once()

    async def test_lifespan_requeue_pending_called_with_db_session(self):
        """requeue_pending_on_startup receives a DB session from AsyncSessionLocal."""
        from unittest.mock import AsyncMock, MagicMock, patch
        from fastapi import FastAPI
        from app.main import lifespan

        mock_db = AsyncMock()
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)

        captured_db_args = []

        mock_email_service = MagicMock()
        mock_email_service.requeue_pending_on_startup = AsyncMock(
            side_effect=lambda db: captured_db_args.append(db)
        )

        with (
            patch("app.main._check_migration_head", AsyncMock()),
            patch("app.database.AsyncSessionLocal", mock_session_local),
            patch("app.services.email_service.EmailService", return_value=mock_email_service),
        ):
            app_instance = FastAPI()
            async with lifespan(app_instance):
                pass

        assert len(captured_db_args) == 1
        assert captured_db_args[0] is mock_db

    # --- Edge cases ---

    async def test_lifespan_check_migration_head_raises_does_not_call_requeue(self):
        """If _check_migration_head raises, requeue_pending_on_startup is NOT called."""
        from unittest.mock import AsyncMock, MagicMock, patch
        from fastapi import FastAPI
        from app.main import lifespan

        mock_email_service = MagicMock()
        mock_email_service.requeue_pending_on_startup = AsyncMock()

        mock_db = AsyncMock()
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)

        async def raising_check():
            raise RuntimeError("Migration head mismatch")

        with (
            patch("app.main._check_migration_head", raising_check),
            patch("app.database.AsyncSessionLocal", mock_session_local),
            patch("app.services.email_service.EmailService", return_value=mock_email_service),
        ):
            app_instance = FastAPI()
            with pytest.raises(RuntimeError, match="Migration head mismatch"):
                async with lifespan(app_instance):
                    pass  # pragma: no cover

        # requeue must not have been called
        mock_email_service.requeue_pending_on_startup.assert_not_awaited()

    # --- Retry / transient error ---

    async def test_lifespan_retries_on_transient_error_then_succeeds(self):
        """Lifespan retries startup DB tasks when a transient OperationalError fires on first attempt."""
        import asyncio
        from unittest.mock import AsyncMock, MagicMock, patch
        from fastapi import FastAPI
        from sqlalchemy.exc import OperationalError
        from app.main import lifespan

        attempt_count = 0

        async def flaky_check():
            nonlocal attempt_count
            attempt_count += 1
            if attempt_count == 1:
                raise OperationalError("connect", {}, Exception("timeout"))

        mock_email_service = MagicMock()
        mock_email_service.requeue_pending_on_startup = AsyncMock()

        mock_db = AsyncMock()
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)

        with (
            patch("app.main._check_migration_head", flaky_check),
            patch("app.database.AsyncSessionLocal", mock_session_local),
            patch("app.services.email_service.EmailService", return_value=mock_email_service),
            patch("asyncio.sleep", AsyncMock()) as mock_sleep,
        ):
            app_instance = FastAPI()
            async with lifespan(app_instance):
                pass

        # First attempt failed; second succeeded — sleep must have been called once (2s backoff)
        assert attempt_count == 2
        mock_sleep.assert_awaited_once_with(2)
        mock_email_service.requeue_pending_on_startup.assert_awaited_once()

    async def test_lifespan_exhausts_retries_without_sleep_on_last_attempt(self):
        """Lifespan does not sleep after the fifth (final) attempt, and silently continues."""
        import asyncio
        from unittest.mock import AsyncMock, MagicMock, patch
        from fastapi import FastAPI
        from sqlalchemy.exc import DBAPIError
        from app.main import lifespan

        async def always_fail():
            raise DBAPIError("connect", {}, Exception("conn refused"))

        mock_email_service = MagicMock()
        mock_email_service.requeue_pending_on_startup = AsyncMock()

        mock_db = AsyncMock()
        mock_session_ctx = AsyncMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_session_local = MagicMock(return_value=mock_session_ctx)

        sleep_calls = []

        async def record_sleep(secs):
            sleep_calls.append(secs)

        with (
            patch("app.main._check_migration_head", always_fail),
            patch("app.database.AsyncSessionLocal", mock_session_local),
            patch("app.services.email_service.EmailService", return_value=mock_email_service),
            patch("asyncio.sleep", record_sleep),
        ):
            app_instance = FastAPI()
            # lifespan does not re-raise transient errors — it silently continues after exhausting retries
            async with lifespan(app_instance):
                pass

        # Attempts 0-3 sleep (2s, 4s, 8s, 16s); attempt 4 is the last so no sleep
        assert sleep_calls == [2, 4, 8, 16]
        mock_email_service.requeue_pending_on_startup.assert_not_awaited()
