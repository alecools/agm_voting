"""Tests for admin authentication endpoints — /api/admin/auth/."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db

# ---------------------------------------------------------------------------
# Admin auth endpoints
# ---------------------------------------------------------------------------


class TestAdminAuth:
    # --- Happy path ---

    async def test_login_valid_credentials_returns_ok(self, db_session: AsyncSession):
        """Valid username + password → {"ok": true}."""
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

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
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

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
        """_verify_admin_password delegates to _pwd_context.verify for bcrypt-prefixed hashes."""
        from unittest.mock import patch
        from app.routers.admin_auth import _verify_admin_password

        # Use a bcrypt-prefixed stored value to trigger the bcrypt branch (line 30).
        # Patch _pwd_context.verify so we don't need a real bcrypt hash computation.
        with patch("app.routers.admin_auth._pwd_context") as mock_ctx:
            mock_ctx.verify.return_value = True
            result = _verify_admin_password("mypass", "$2b$12$fakehash")
        mock_ctx.verify.assert_called_once_with("mypass", "$2b$12$fakehash")
        assert result is True

    async def test_hash_password_endpoint_returns_bcrypt_hash(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns a bcrypt hash in non-production."""
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        # Patch _pwd_context.hash to avoid real bcrypt computation in test env
        with patch("app.routers.admin_auth._pwd_context") as mock_ctx:
            mock_ctx.hash.return_value = "$2b$12$mockedhashvalue"
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/hash-password",
                    json={"password": "mypassword"},
                )
        assert response.status_code == 200
        data = response.json()
        assert data["hash"] == "$2b$12$mockedhashvalue"

    async def test_hash_password_endpoint_returns_404_in_production(self, db_session: AsyncSession):
        """POST /api/admin/auth/hash-password returns 404 when ENVIRONMENT=production."""
        from unittest.mock import patch
        from app.main import create_app

        app_instance = create_app()

        async def override_get_db():
            yield db_session

        app_instance.dependency_overrides[get_db] = override_get_db

        with patch.object(__import__("app.config", fromlist=["settings"]).settings, "environment", "production"):
            async with AsyncClient(
                transport=ASGITransport(app=app_instance), base_url="http://test"
            ) as c:
                response = await c.post(
                    "/api/admin/auth/hash-password",
                    json={"password": "mypassword"},
                )
        assert response.status_code == 404


