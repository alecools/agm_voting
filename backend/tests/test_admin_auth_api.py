"""Tests for Better Auth admin authentication — require_admin dependency,
AdminLoginRateLimitMiddleware, and get_client_ip helper."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sql_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import BetterAuthUser, get_client_ip, require_admin
from app.models.admin_login_attempt import AdminLoginAttempt


# ---------------------------------------------------------------------------
# get_client_ip helper
# ---------------------------------------------------------------------------


class TestGetClientIp:
    """Tests for get_client_ip() helper — reads real IP from X-Forwarded-For (RR3-15)."""

    # --- Happy path ---

    def test_returns_first_ip_from_x_forwarded_for(self):
        """When X-Forwarded-For is present, the first IP is returned."""
        request = MagicMock()
        request.headers = {"X-Forwarded-For": "203.0.113.1, 10.0.0.1, 172.16.0.1"}
        request.client = MagicMock()
        request.client.host = "10.0.0.2"

        assert get_client_ip(request) == "203.0.113.1"

    def test_strips_whitespace_from_forwarded_ip(self):
        """Whitespace around the first IP in X-Forwarded-For is stripped."""
        request = MagicMock()
        request.headers = {"X-Forwarded-For": "  198.51.100.42 , 10.0.0.1"}
        request.client = MagicMock()
        request.client.host = "10.0.0.2"

        assert get_client_ip(request) == "198.51.100.42"

    def test_single_ip_in_x_forwarded_for(self):
        """A single IP in X-Forwarded-For (no proxy chain) is returned as-is."""
        request = MagicMock()
        request.headers = {"X-Forwarded-For": "198.51.100.5"}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        assert get_client_ip(request) == "198.51.100.5"

    # --- Fallback ---

    def test_falls_back_to_request_client_host(self):
        """When X-Forwarded-For is absent, request.client.host is returned."""
        request = MagicMock()
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        assert get_client_ip(request) == "127.0.0.1"

    def test_returns_unknown_when_no_client_and_no_header(self):
        """Returns 'unknown' when both X-Forwarded-For and request.client are absent."""
        request = MagicMock()
        request.headers = {}
        request.client = None

        assert get_client_ip(request) == "unknown"


# ---------------------------------------------------------------------------
# require_admin dependency
# ---------------------------------------------------------------------------


def _make_request_with_cookie(cookie_header: str) -> MagicMock:
    """Build a mock Request with the given raw cookie header string."""
    request = MagicMock()
    request.headers = {"cookie": cookie_header} if cookie_header else {}
    return request


class TestRequireAdmin:
    """Tests for the require_admin FastAPI dependency."""

    # --- Happy path ---

    async def test_valid_session_returns_better_auth_user(self):
        """Valid session token → BetterAuthUser with email and user_id."""
        request = _make_request_with_cookie("better-auth.session_token=valid-token-abc")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "session": {"id": "sess-1"},
            "user": {"id": "user-uuid-1", "email": "admin@example.com"},
        }

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                result = await require_admin(request)

        assert isinstance(result, BetterAuthUser)
        assert result.email == "admin@example.com"
        assert result.user_id == "user-uuid-1"

    async def test_accepts_secure_prefixed_cookie_name(self):
        """__Secure-neon-auth.session_token (HTTPS cookie) is accepted."""
        request = _make_request_with_cookie(
            "__Secure-neon-auth.session_token=tok.sig; other-cookie=x"
        )

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "user": {"id": "u1", "email": "admin@example.com"},
        }

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                result = await require_admin(request)

        assert isinstance(result, BetterAuthUser)

    async def test_forwards_all_cookies_verbatim(self):
        """All cookies are forwarded verbatim so Neon Auth can pick the right one."""
        raw = "__Secure-neon-auth.session_token=tok.sig; agm_session=xyz"
        request = _make_request_with_cookie(raw)

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"user": {"id": "u1", "email": "a@b.com"}}

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                await require_admin(request)

        forwarded = mock_client.get.call_args[1]["headers"]["cookie"]
        assert forwarded == raw

    async def test_calls_get_session_endpoint(self):
        """require_admin calls {neon_auth_base_url}/get-session (not /api/auth/get-session)."""
        request = _make_request_with_cookie("better-auth.session_token=tok")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"user": {"id": "u1", "email": "admin@example.com"}}

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com/neondb/auth"
                await require_admin(request)

        called_url = mock_client.get.call_args[0][0]
        assert called_url == "https://auth.example.com/neondb/auth/get-session"
        assert "/api/auth/get-session" not in called_url

    async def test_strips_trailing_newline_from_neon_auth_base_url(self):
        """neon_auth_base_url with trailing newline is stripped before constructing URL."""
        request = _make_request_with_cookie("better-auth.session_token=tok")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"user": {"id": "u1", "email": "admin@example.com"}}

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com\n"
                result = await require_admin(request)

        called_url = mock_client.get.call_args[0][0]
        assert "\n" not in called_url
        assert called_url == "https://auth.example.com/get-session"
        assert isinstance(result, BetterAuthUser)

    # --- Auth failures ---

    async def test_missing_cookie_raises_401(self):
        """No session_token cookie → 401."""
        from fastapi import HTTPException

        request = _make_request_with_cookie("")

        with pytest.raises(HTTPException) as exc_info:
            await require_admin(request)

        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == "Authentication required"

    async def test_unrelated_cookie_only_raises_401(self):
        """Cookie header with no session_token key → 401."""
        from fastapi import HTTPException

        request = _make_request_with_cookie("agm_session=abc; other=xyz")

        with pytest.raises(HTTPException) as exc_info:
            await require_admin(request)

        assert exc_info.value.status_code == 401

    async def test_non_200_response_raises_401(self):
        """Neon Auth returns 401 on all retries → our dependency raises 401."""
        from fastapi import HTTPException

        request = _make_request_with_cookie("better-auth.session_token=expired-token")

        mock_response = MagicMock()
        mock_response.status_code = 401

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                with patch("app.dependencies.asyncio.sleep", new=AsyncMock()):
                    with pytest.raises(HTTPException) as exc_info:
                        await require_admin(request)

        assert exc_info.value.status_code == 401

    async def test_retries_on_non_200_then_succeeds(self):
        """Neon Auth returns 401 twice then 200 → dependency succeeds (cold-start retry)."""
        request = _make_request_with_cookie("better-auth.session_token=valid-token")

        fail_response = MagicMock()
        fail_response.status_code = 401

        success_response = MagicMock()
        success_response.status_code = 200
        success_response.json.return_value = {"user": {"id": "u1", "email": "admin@example.com"}}

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=[fail_response, fail_response, success_response])
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                with patch("app.dependencies.asyncio.sleep", new=AsyncMock()):
                    result = await require_admin(request)

        assert isinstance(result, BetterAuthUser)
        assert result.email == "admin@example.com"
        assert mock_client.get.call_count == 3

    async def test_null_user_in_response_raises_401(self):
        """Neon Auth returns 200 but user is null → 401."""
        from fastapi import HTTPException

        request = _make_request_with_cookie("better-auth.session_token=some-token")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"session": {}, "user": None}

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                with pytest.raises(HTTPException) as exc_info:
                    await require_admin(request)

        assert exc_info.value.status_code == 401

    async def test_empty_body_raises_401(self):
        """Neon Auth returns 200 with empty body → 401."""
        from fastapi import HTTPException

        request = _make_request_with_cookie("better-auth.session_token=some-token")

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = None

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                with pytest.raises(HTTPException) as exc_info:
                    await require_admin(request)

        assert exc_info.value.status_code == 401

    async def test_network_error_raises_503(self):
        """Network error on all retries calling Neon Auth → 503."""
        import httpx
        from fastapi import HTTPException

        request = _make_request_with_cookie("better-auth.session_token=some-token")

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=httpx.RequestError("connection refused"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                with patch("app.dependencies.asyncio.sleep", new=AsyncMock()):
                    with pytest.raises(HTTPException) as exc_info:
                        await require_admin(request)

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Auth service unavailable"

    # --- Integration: require_admin used by admin endpoints ---

    async def test_admin_endpoint_returns_401_without_session_cookie(self, db_session: AsyncSession):
        """Admin endpoints return 401 when the session cookie is absent."""
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db
        # No require_admin override — let the real dependency run with no cookie

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as c:
            response = await c.get(
                "/api/admin/buildings",
                headers={"X-Requested-With": "XMLHttpRequest"},
            )

        assert response.status_code == 401

    async def test_admin_endpoint_returns_401_when_neon_auth_returns_non_200(self, db_session: AsyncSession):
        """Admin endpoint returns 401 when Neon Auth returns non-200 for the session."""
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        mock_response = MagicMock()
        mock_response.status_code = 401

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                with patch("app.dependencies.asyncio.sleep", new=AsyncMock()):
                    async with AsyncClient(
                        transport=ASGITransport(app=app_instance), base_url="http://test"
                    ) as c:
                        response = await c.get(
                            "/api/admin/buildings",
                            cookies={"better-auth.session_token": "invalid-token"},
                            headers={"X-Requested-With": "XMLHttpRequest"},
                        )

        assert response.status_code == 401

    async def test_admin_endpoint_returns_200_with_valid_session(self, db_session: AsyncSession):
        """Admin endpoint returns 200 when Neon Auth validates the session."""
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "session": {"id": "sess-1"},
            "user": {"id": "user-1", "email": "admin@example.com"},
        }

        with patch("app.dependencies.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            with patch("app.dependencies.settings") as mock_settings:
                mock_settings.neon_auth_base_url = "https://auth.example.com"
                async with AsyncClient(
                    transport=ASGITransport(app=app_instance), base_url="http://test"
                ) as c:
                    response = await c.get(
                        "/api/admin/buildings",
                        cookies={"better-auth.session_token": "valid-token"},
                        headers={"X-Requested-With": "XMLHttpRequest"},
                    )

        assert response.status_code == 200


# ---------------------------------------------------------------------------
# AdminLoginRateLimitMiddleware
# ---------------------------------------------------------------------------


def _make_mock_db_session(attempt_record=None):
    """Build a mock AsyncSession that returns attempt_record from execute().scalar_one_or_none()."""
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = attempt_record

    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(return_value=mock_result)
    mock_db.add = MagicMock()
    mock_db.flush = AsyncMock()
    mock_db.commit = AsyncMock()
    mock_db.__aenter__ = AsyncMock(return_value=mock_db)
    mock_db.__aexit__ = AsyncMock(return_value=False)
    return mock_db


def _make_session_factory(*sessions):
    """Return a callable that yields each session in sequence (one per `async with` call)."""
    from contextlib import asynccontextmanager

    sessions_iter = iter(sessions)

    @asynccontextmanager
    async def _factory():
        yield next(sessions_iter)

    return _factory


class TestAdminLoginRateLimitMiddleware:
    """Tests for the rate-limit middleware wrapping POST /api/auth/sign-in/email.

    The middleware imports AsyncSessionLocal inside dispatch() so tests patch
    app.database.AsyncSessionLocal to inject mock sessions without needing real
    DB connections.  Each test supplies two mock sessions (pre-check and
    post-response) via _make_session_factory.
    """

    # --- Happy path ---

    async def test_non_target_path_passes_through(self, db_session: AsyncSession):
        """Requests to paths other than /api/auth/sign-in/email are not intercepted."""
        from app.main import create_app

        app_instance = create_app()
        app_instance.dependency_overrides[get_db] = lambda: db_session
        app_instance.dependency_overrides[require_admin] = lambda: BetterAuthUser(
            email="admin@example.com", user_id="u1"
        )

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as c:
            response = await c.get("/api/health/live")

        assert response.status_code == 200

    async def test_failed_sign_in_records_attempt(self):
        """A non-2xx response from Better Auth causes a failure record to be created."""
        from starlette.responses import JSONResponse as StarletteJSONResponse
        from app.main import AdminLoginRateLimitMiddleware

        # Pre-check: no existing record (IP not yet rate-limited)
        pre_db = _make_mock_db_session(attempt_record=None)
        # Post-response: still no existing record (first failure)
        post_db = _make_mock_db_session(attempt_record=None)
        factory = _make_session_factory(pre_db, post_db)

        added_records: list = []
        post_db.add = MagicMock(side_effect=lambda r: added_records.append(r))

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        async def fake_call_next(_req):
            return StarletteJSONResponse({"detail": "bad credentials"}, status_code=401)

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, fake_call_next)

        assert response.status_code == 401
        assert len(added_records) == 1
        assert added_records[0].ip_address == "127.0.0.1"
        assert added_records[0].failed_count == 1
        post_db.commit.assert_called_once()

    async def test_successful_sign_in_clears_attempt_record(self):
        """A 2xx response from Better Auth clears any existing failure record."""
        from starlette.responses import JSONResponse as StarletteJSONResponse
        from app.main import AdminLoginRateLimitMiddleware

        now = datetime.now(UTC)
        existing = MagicMock(spec=AdminLoginAttempt)
        existing.id = "some-uuid"
        existing.failed_count = 3
        existing.first_attempt_at = now - timedelta(minutes=5)

        pre_db = _make_mock_db_session(attempt_record=existing)
        post_db = _make_mock_db_session(attempt_record=existing)
        factory = _make_session_factory(pre_db, post_db)

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        async def fake_call_next(_req):
            return StarletteJSONResponse({"ok": True}, status_code=200)

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, fake_call_next)

        assert response.status_code == 200
        # execute was called on post_db with a DELETE statement (clearing the record)
        assert post_db.execute.call_count >= 1
        post_db.commit.assert_called_once()

    async def test_rate_limited_after_max_failures(self):
        """IP with >= MAX_FAILURES failures within window returns 429 before calling handler."""
        from app.main import AdminLoginRateLimitMiddleware

        now = datetime.now(UTC)
        blocked = MagicMock(spec=AdminLoginAttempt)
        blocked.id = "blocked-uuid"
        blocked.failed_count = 5  # == _MAX_FAILURES
        blocked.first_attempt_at = now - timedelta(minutes=5)

        # Only pre-check session needed — 429 is returned before call_next
        pre_db = _make_mock_db_session(attempt_record=blocked)
        factory = _make_session_factory(pre_db)

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        call_next_called = []

        async def fake_call_next(_req):
            call_next_called.append(True)
            return MagicMock(status_code=200)

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, fake_call_next)

        assert response.status_code == 429
        import json as _json
        body = _json.loads(response.body.decode())
        assert "Too many failed login attempts" in body["detail"]
        # retry_after_seconds must be present and positive
        assert "retry_after_seconds" in body
        assert body["retry_after_seconds"] > 0
        # Retry-After HTTP header must be set to the same value
        assert response.headers.get("retry-after") == str(body["retry_after_seconds"])
        assert not call_next_called  # handler was never called

    async def test_expired_window_record_is_cleared_and_request_proceeds(self):
        """An expired rate-limit record is deleted and the request proceeds (not blocked)."""
        from starlette.responses import JSONResponse as StarletteJSONResponse
        from app.main import AdminLoginRateLimitMiddleware

        now = datetime.now(UTC)
        expired = MagicMock(spec=AdminLoginAttempt)
        expired.id = "expired-uuid"
        expired.failed_count = 5
        # first_attempt_at more than 15 minutes ago — stale window
        expired.first_attempt_at = now - timedelta(minutes=30)

        # After deletion, second query in post-response sees None
        pre_db = _make_mock_db_session(attempt_record=expired)
        post_db = _make_mock_db_session(attempt_record=None)
        factory = _make_session_factory(pre_db, post_db)

        added_records: list = []
        post_db.add = MagicMock(side_effect=lambda r: added_records.append(r))

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        async def fake_call_next(_req):
            return StarletteJSONResponse({"ok": True}, status_code=200)

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, fake_call_next)

        # Not blocked — expired record was cleared
        assert response.status_code == 200
        # pre_db.execute was called at least twice: SELECT and DELETE
        assert pre_db.execute.call_count >= 2

    async def test_failed_sign_in_increments_existing_attempt_record(self):
        """A non-2xx response increments failed_count on an existing attempt record."""
        from starlette.responses import JSONResponse as StarletteJSONResponse
        from app.main import AdminLoginRateLimitMiddleware

        now = datetime.now(UTC)
        existing = MagicMock(spec=AdminLoginAttempt)
        existing.id = "existing-uuid"
        existing.failed_count = 2
        existing.first_attempt_at = now - timedelta(minutes=3)
        existing.last_attempt_at = now - timedelta(minutes=1)

        pre_db = _make_mock_db_session(attempt_record=existing)
        post_db = _make_mock_db_session(attempt_record=existing)
        factory = _make_session_factory(pre_db, post_db)

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        async def fake_call_next(_req):
            return StarletteJSONResponse({"detail": "bad"}, status_code=401)

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, fake_call_next)

        assert response.status_code == 401
        # failed_count must have been incremented on the existing record
        assert existing.failed_count == 3
        post_db.commit.assert_called_once()

    async def test_rate_limit_uses_forwarded_ip(self):
        """Rate-limit record uses the X-Forwarded-For IP, not the direct connection IP."""
        from starlette.responses import JSONResponse as StarletteJSONResponse
        from app.main import AdminLoginRateLimitMiddleware

        test_ip = "203.0.113.55"

        pre_db = _make_mock_db_session(attempt_record=None)
        post_db = _make_mock_db_session(attempt_record=None)
        factory = _make_session_factory(pre_db, post_db)

        added_records: list = []
        post_db.add = MagicMock(side_effect=lambda r: added_records.append(r))

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {"X-Forwarded-For": f"{test_ip}, 10.0.0.1"}
        request.client = MagicMock()
        request.client.host = "10.0.0.2"

        async def fake_call_next(_req):
            return StarletteJSONResponse({"detail": "bad"}, status_code=401)

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, fake_call_next)

        assert response.status_code == 401
        assert len(added_records) == 1
        assert added_records[0].ip_address == test_ip  # keyed on forwarded IP

    async def test_get_method_to_target_path_passes_through(self, db_session: AsyncSession):
        """GET requests to /api/auth/sign-in/email are not rate-limited (only POST)."""
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db
        app_instance.dependency_overrides[require_admin] = lambda: BetterAuthUser(
            email="admin@example.com", user_id="u1"
        )

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as c:
            response = await c.get("/api/auth/sign-in/email")

        assert response.status_code != 429

    async def test_429_retry_after_seconds_calculated_from_window_expiry(self):
        """retry_after_seconds in 429 body reflects remaining seconds until window expiry."""
        from app.main import AdminLoginRateLimitMiddleware

        now = datetime.now(UTC)
        # first_attempt_at was 5 minutes ago; window is 15 minutes → 10 minutes remain
        blocked = MagicMock(spec=AdminLoginAttempt)
        blocked.id = "blocked-uuid"
        blocked.failed_count = 5
        blocked.first_attempt_at = now - timedelta(minutes=5)

        pre_db = _make_mock_db_session(attempt_record=blocked)
        factory = _make_session_factory(pre_db)

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "1.2.3.4"

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, lambda _: None)

        assert response.status_code == 429
        import json as _json
        body = _json.loads(response.body.decode())
        # 5 minutes elapsed of a 15-minute window → ~10 minutes remain (600 seconds ± a few)
        assert 595 <= body["retry_after_seconds"] <= 605
        assert response.headers.get("retry-after") == str(body["retry_after_seconds"])

    async def test_429_retry_after_seconds_minimum_is_one(self):
        """retry_after_seconds is at least 1 even when the window is nearly expired."""
        from app.main import AdminLoginRateLimitMiddleware

        now = datetime.now(UTC)
        # first_attempt_at is almost exactly 15 minutes ago (window nearly expired)
        blocked = MagicMock(spec=AdminLoginAttempt)
        blocked.id = "near-expiry-uuid"
        blocked.failed_count = 5
        blocked.first_attempt_at = now - timedelta(seconds=899)  # 1 second before expiry

        pre_db = _make_mock_db_session(attempt_record=blocked)
        factory = _make_session_factory(pre_db)

        mw = AdminLoginRateLimitMiddleware(app=MagicMock())

        request = MagicMock()
        request.method = "POST"
        request.url.path = "/api/auth/sign-in/email"
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "1.2.3.4"

        with patch("app.database.AsyncSessionLocal", factory):
            response = await mw.dispatch(request, lambda _: None)

        import json as _json
        body = _json.loads(response.body.decode())
        assert body["retry_after_seconds"] >= 1
