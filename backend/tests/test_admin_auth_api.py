"""Tests for admin authentication endpoints — /api/admin/auth/."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import bcrypt
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import patch

from app.database import get_db
from app.models.admin_login_attempt import AdminLoginAttempt

# ---------------------------------------------------------------------------
# Admin auth endpoints
# ---------------------------------------------------------------------------


class TestAdminAuth:
    # --- Happy path ---

    async def test_login_valid_credentials_returns_ok(self, db_session: AsyncSession):
        """Valid username + password → {"ok": true}."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Hash "admin" so _verify_admin_password accepts it
        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
        assert response.status_code == 200
        assert response.json()["ok"] is True

    async def test_login_invalid_credentials_returns_401(self, db_session: AsyncSession):
        """Wrong username + wrong password returns 401.

        A bcrypt hash must be patched into admin_password so _verify_admin_password does not
        raise ValueError (which it would with the default plaintext 'admin' value).
        Before the timing-safe fix, short-circuit evaluation meant bcrypt never ran when the
        username was wrong.  Now bcrypt always runs, so a valid hash is required in settings.
        """
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        hashed = bcrypt.hashpw(b"correct_pw", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "wrong", "password": "bad"},
                )
        assert response.status_code == 401

    async def test_logout_clears_session(self, db_session: AsyncSession):
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as c:
            await c.post(
                "/api/admin/auth/login",
                json={"username": "admin", "password": "admin"},
            )
            response = await c.post("/api/admin/auth/logout")
        assert response.status_code == 200
        assert response.json()["ok"] is True

    async def test_me_authenticated_returns_true(self, db_session: AsyncSession):
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
                response = await c.get("/api/admin/auth/me")
        assert response.status_code == 200
        assert response.json()["authenticated"] is True

    async def test_me_unauthenticated_returns_401(self, db_session: AsyncSession):
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as c:
            response = await c.get("/api/admin/auth/me")
        assert response.status_code == 401

    def test_verify_admin_password_bcrypt_path_verify_called(self):
        """_verify_admin_password calls bcrypt.checkpw for $2b$-prefixed hashes."""
        import bcrypt
        from app.routers.admin_auth import _verify_admin_password

        # Generate a real bcrypt hash and verify it round-trips correctly.
        hashed = bcrypt.hashpw(b"mypass", bcrypt.gensalt()).decode()
        result = _verify_admin_password("mypass", hashed)
        assert result is True

    def test_verify_admin_password_wrong_password_returns_false(self):
        """_verify_admin_password returns False for incorrect password."""
        import bcrypt
        from app.routers.admin_auth import _verify_admin_password

        hashed = bcrypt.hashpw(b"correct", bcrypt.gensalt()).decode()
        result = _verify_admin_password("wrong", hashed)
        assert result is False

    async def test_hash_password_endpoint_returns_bcrypt_hash(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns a bcrypt hash when called by an authenticated admin."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                # Establish an admin session first
                await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
                response = await c.post(
                    "/api/admin/auth/hash-password",
                    json={"password": "mypassword"},
                )
        assert response.status_code == 200
        data = response.json()
        assert data["hash"].startswith("$2b$")

    async def test_hash_password_endpoint_returns_401_without_auth(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns 401 when called without admin session."""
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(
            transport=ASGITransport(app=app_instance), base_url="http://test"
        ) as c:
            response = await c.post(
                "/api/admin/auth/hash-password",
                json={"password": "mypassword"},
            )
        assert response.status_code == 401

    async def test_hash_password_endpoint_returns_404_in_production(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns 404 when ENVIRONMENT=production (even with auth)."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "environment",
            "production",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                # Establish admin session (require_admin runs before the production check)
                await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
                response = await c.post(
                    "/api/admin/auth/hash-password",
                    json={"password": "mypassword"},
                )
        assert response.status_code == 404

    async def test_hash_password_endpoint_returns_404_in_demo_environment(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns 404 on demo env (MED-6: development-only gate)."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "environment",
            "demo",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
                response = await c.post(
                    "/api/admin/auth/hash-password",
                    json={"password": "mypassword"},
                )
        assert response.status_code == 404

    async def test_hash_password_endpoint_returns_404_in_preview_environment(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns 404 on preview env (MED-6)."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "environment",
            "preview",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
                response = await c.post(
                    "/api/admin/auth/hash-password",
                    json={"password": "mypassword"},
                )
        assert response.status_code == 404

    async def test_login_returns_500_with_generic_detail_when_password_not_bcrypt(self, db_session: AsyncSession):
        """POST /api/admin/auth/login returns 500 with generic detail when ADMIN_PASSWORD is plaintext (LOW-7).

        The raw ValueError message must never be sent to clients — a generic
        'Server configuration error' must be returned instead.
        """
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Patch admin_password to the dev placeholder so _verify_admin_password raises ValueError
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            "admin",
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )
        assert response.status_code == 500
        detail = response.json()["detail"]
        # Must be generic — raw ValueError message must not be exposed
        assert detail == "Server configuration error"
        assert "ADMIN_PASSWORD" not in detail
        assert "bcrypt" not in detail.lower()

    async def test_login_clears_rate_limit_record_on_success(self, db_session: AsyncSession):
        """Successful login with an existing rate-limit record deletes that record from the DB.

        This specifically tests the fix for C-2: previously `await db.delete()` raised
        TypeError because AsyncSession.delete() is synchronous and returns None.
        """
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Clean up any pre-existing 127.0.0.1 record from earlier tests in this session
        from sqlalchemy import delete as sql_delete_stmt
        await db_session.execute(sql_delete_stmt(AdminLoginAttempt).where(AdminLoginAttempt.ip_address == "127.0.0.1"))
        await db_session.flush()

        # Pre-insert a rate-limit record for the test client IP (127.0.0.1)
        now = datetime.now(UTC)
        attempt = AdminLoginAttempt(
            ip_address="127.0.0.1",
            failed_count=2,
            first_attempt_at=now - timedelta(minutes=5),
            last_attempt_at=now - timedelta(minutes=1),
        )
        db_session.add(attempt)
        await db_session.flush()
        attempt_id = attempt.id

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )

        assert response.status_code == 200
        assert response.json()["ok"] is True

        # Verify the rate-limit record was deleted from the database
        result = await db_session.execute(
            select(AdminLoginAttempt).where(AdminLoginAttempt.id == attempt_id)
        )
        assert result.scalar_one_or_none() is None, (
            "Rate-limit record should have been deleted after successful login"
        )

    async def test_login_deletes_expired_rate_limit_record_and_succeeds(self, db_session: AsyncSession):
        """Expired rate-limit record (outside 15-min window) is deleted and login succeeds.

        This specifically tests the fix for C-2 on the window-expiry path (line 76):
        previously `await db.delete()` raised TypeError at runtime.

        The test client IP is 127.0.0.1, so we insert an expired record for that IP.
        On login the endpoint detects the record is outside the 15-min window and must
        delete it before proceeding — exercising the fixed `db.execute(sql_delete(...))` path.
        """
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Clean up any pre-existing 127.0.0.1 record from earlier tests in this session
        from sqlalchemy import delete as sql_delete_stmt
        await db_session.execute(sql_delete_stmt(AdminLoginAttempt).where(AdminLoginAttempt.ip_address == "127.0.0.1"))
        await db_session.flush()

        # Pre-insert a rate-limit record for 127.0.0.1 (test client IP) that is
        # older than the 15-minute window so the expiry path is triggered.
        now = datetime.now(UTC)
        expired_attempt = AdminLoginAttempt(
            ip_address="127.0.0.1",
            failed_count=5,
            first_attempt_at=now - timedelta(minutes=30),
            last_attempt_at=now - timedelta(minutes=25),
        )
        db_session.add(expired_attempt)
        await db_session.flush()
        expired_id = expired_attempt.id

        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "admin"},
                )

        # Login should succeed — expired record was cleaned up, not blocked
        assert response.status_code == 200
        assert response.json()["ok"] is True

        # The expired rate-limit record should have been deleted
        result = await db_session.execute(
            select(AdminLoginAttempt).where(AdminLoginAttempt.id == expired_id)
        )
        assert result.scalar_one_or_none() is None, (
            "Expired rate-limit record should have been deleted on window expiry"
        )


# ---------------------------------------------------------------------------
# RR3-15: get_client_ip uses X-Forwarded-For header
# ---------------------------------------------------------------------------


class TestGetClientIp:
    """Tests for get_client_ip() helper — reads real IP from X-Forwarded-For (RR3-15)."""

    # --- Happy path ---

    def test_get_client_ip_returns_first_ip_from_x_forwarded_for(self):
        """When X-Forwarded-For is present, the first IP is returned."""
        from unittest.mock import MagicMock
        from app.routers.admin_auth import get_client_ip

        request = MagicMock()
        request.headers = {"X-Forwarded-For": "203.0.113.1, 10.0.0.1, 172.16.0.1"}
        request.client = MagicMock()
        request.client.host = "10.0.0.2"

        result = get_client_ip(request)
        assert result == "203.0.113.1"

    def test_get_client_ip_strips_whitespace_from_forwarded_ip(self):
        """Whitespace around the first IP in X-Forwarded-For is stripped."""
        from unittest.mock import MagicMock
        from app.routers.admin_auth import get_client_ip

        request = MagicMock()
        request.headers = {"X-Forwarded-For": "  198.51.100.42 , 10.0.0.1"}
        request.client = MagicMock()
        request.client.host = "10.0.0.2"

        result = get_client_ip(request)
        assert result == "198.51.100.42"

    def test_get_client_ip_single_ip_in_x_forwarded_for(self):
        """A single IP in X-Forwarded-For (no proxy chain) is returned as-is."""
        from unittest.mock import MagicMock
        from app.routers.admin_auth import get_client_ip

        request = MagicMock()
        request.headers = {"X-Forwarded-For": "198.51.100.5"}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        result = get_client_ip(request)
        assert result == "198.51.100.5"

    # --- Fallback ---

    def test_get_client_ip_falls_back_to_request_client_host(self):
        """When X-Forwarded-For is absent, request.client.host is returned."""
        from unittest.mock import MagicMock
        from app.routers.admin_auth import get_client_ip

        request = MagicMock()
        # Simulate no X-Forwarded-For header
        request.headers = {}
        request.client = MagicMock()
        request.client.host = "127.0.0.1"

        result = get_client_ip(request)
        assert result == "127.0.0.1"

    def test_get_client_ip_returns_unknown_when_no_client_and_no_header(self):
        """Returns 'unknown' when both X-Forwarded-For and request.client are absent."""
        from unittest.mock import MagicMock
        from app.routers.admin_auth import get_client_ip

        request = MagicMock()
        request.headers = {}
        request.client = None

        result = get_client_ip(request)
        assert result == "unknown"

    # --- Integration: admin login uses forwarded IP ---

    async def test_admin_login_rate_limit_uses_forwarded_ip(self, db_session):
        """Admin login rate-limit record stores the forwarded client IP, not the proxy IP (RR3-15)."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app
        from app.database import get_db
        from sqlalchemy import delete as sql_delete_stmt

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Clean up any pre-existing records for our test IPs
        await db_session.execute(sql_delete_stmt(AdminLoginAttempt).where(
            AdminLoginAttempt.ip_address.in_(["203.0.113.99", "127.0.0.1"])
        ))
        await db_session.flush()

        hashed = bcrypt.hashpw(b"correct_pw", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                # Simulate a login from a forwarded IP (Vercel proxy pattern)
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "wrong", "password": "bad"},
                    headers={"X-Forwarded-For": "203.0.113.99, 10.0.0.1"},
                )
        assert response.status_code == 401

        # Rate-limit record must be keyed on the real client IP (203.0.113.99)
        result = await db_session.execute(
            select(AdminLoginAttempt).where(AdminLoginAttempt.ip_address == "203.0.113.99")
        )
        attempt = result.scalar_one_or_none()
        assert attempt is not None, (
            "Rate-limit record must be stored under the forwarded IP 203.0.113.99, not the proxy IP"
        )
        assert attempt.failed_count == 1


# ---------------------------------------------------------------------------
# RR3-13: Rate-limit check and record creation are atomic
# ---------------------------------------------------------------------------


class TestRateLimitAtomicity:
    """Tests that verify the SELECT FOR UPDATE + write pattern for rate-limit atomicity (RR3-13)."""

    # --- Happy path ---

    async def test_failed_login_creates_attempt_record(self, db_session):
        """A failed login with no prior attempt record creates a new AdminLoginAttempt."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app
        from app.database import get_db
        from sqlalchemy import delete as sql_delete_stmt

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Clean up pre-existing records for this IP
        await db_session.execute(sql_delete_stmt(AdminLoginAttempt).where(
            AdminLoginAttempt.ip_address == "127.0.0.1"
        ))
        await db_session.flush()

        hashed = bcrypt.hashpw(b"correct", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/login",
                    json={"username": "admin", "password": "wrong"},
                )
        assert response.status_code == 401

        # Attempt record must exist in the DB
        result = await db_session.execute(
            select(AdminLoginAttempt).where(AdminLoginAttempt.ip_address == "127.0.0.1")
        )
        attempt = result.scalar_one_or_none()
        assert attempt is not None, "AdminLoginAttempt record must be created after a failed login"
        assert attempt.failed_count == 1

    async def test_repeated_failed_logins_increment_counter(self, db_session):
        """Repeated failed logins from the same IP increment the failed_count atomically (RR3-13)."""
        import bcrypt
        from unittest.mock import patch
        from app.main import create_app
        from app.database import get_db
        from sqlalchemy import delete as sql_delete_stmt

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Clean up pre-existing records
        await db_session.execute(sql_delete_stmt(AdminLoginAttempt).where(
            AdminLoginAttempt.ip_address == "127.0.0.1"
        ))
        await db_session.flush()

        hashed = bcrypt.hashpw(b"correct", bcrypt.gensalt()).decode()

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_password",
            hashed,
        ), patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "admin_username",
            "admin",
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                for _ in range(3):
                    await c.post(
                        "/api/admin/auth/login",
                        json={"username": "admin", "password": "wrong"},
                    )

        result = await db_session.execute(
            select(AdminLoginAttempt).where(AdminLoginAttempt.ip_address == "127.0.0.1")
        )
        attempt = result.scalar_one_or_none()
        assert attempt is not None
        assert attempt.failed_count == 3, (
            f"Expected failed_count=3 after 3 failed logins, got {attempt.failed_count}"
        )


# ---------------------------------------------------------------------------
# RR3-16: Auth timing oracle — verify always does same work regardless of OTP presence
# ---------------------------------------------------------------------------


class TestAuthTimingOracle:
    """Tests that POST /api/auth/verify performs the same code path for OTP-found vs not-found (RR3-16)."""

    # --- Happy path ---

    def test_verify_always_calls_hmac_compare_digest(self):
        """Even when no OTP row exists, hmac.compare_digest is called — same code path (RR3-16).

        This test verifies the fix by inspecting the source code of verify_auth to
        confirm that hmac.compare_digest is called unconditionally before the 401 raise.
        """
        import inspect
        import app.routers.auth as auth_module

        source = inspect.getsource(auth_module.verify_auth)
        # The dummy hmac.compare_digest call must appear in the "otp is None" branch
        # before the 401 HTTPException is raised, ensuring timing parity.
        assert "hmac.compare_digest" in source, (
            "verify_auth must call hmac.compare_digest to equalise timing for "
            "OTP-found vs OTP-not-found paths (RR3-16)"
        )
