"""
Unit tests for admin user management endpoints.

All Neon Auth service calls are mocked — no real Neon API calls are made.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

# Importing app.main ensures all routers (including app.routers.auth) are loaded
# into sys.modules before the autouse patch_parallel_lot_lookup fixture runs.
import app.main  # noqa: F401

from app.schemas.admin import AdminUserOut
from app.services.neon_auth_service import (
    NeonAuthDuplicateUserError,
    NeonAuthNotConfiguredError,
    NeonAuthServiceError,
    NeonAuthUserNotFoundError,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_USER_1 = AdminUserOut(
    id="user-1",
    email="admin1@example.com",
    created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
)
_USER_2 = AdminUserOut(
    id="user-2",
    email="admin2@example.com",
    created_at=datetime(2026, 2, 1, tzinfo=timezone.utc),
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _patch_list(return_value: list[AdminUserOut]):
    return patch(
        "app.routers.admin.neon_auth_service.list_admin_users",
        new_callable=AsyncMock,
        return_value=return_value,
    )


def _patch_invite(return_value: AdminUserOut | None = None, side_effect=None):
    kwargs: dict = {"new_callable": AsyncMock}
    if side_effect is not None:
        kwargs["side_effect"] = side_effect
    else:
        kwargs["return_value"] = return_value
    return patch("app.routers.admin.neon_auth_service.invite_admin_user", **kwargs)


def _patch_remove(return_value=None, side_effect=None):
    kwargs: dict = {"new_callable": AsyncMock}
    if side_effect is not None:
        kwargs["side_effect"] = side_effect
    else:
        kwargs["return_value"] = return_value
    return patch("app.routers.admin.neon_auth_service.remove_admin_user", **kwargs)


# ---------------------------------------------------------------------------
# GET /api/admin/users
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_users_happy_path(client: AsyncClient):
    """GET /api/admin/users returns 200 with user list."""
    with _patch_list([_USER_1, _USER_2]):
        resp = await client.get("/api/admin/users")
    assert resp.status_code == 200
    data = resp.json()
    assert "users" in data
    assert len(data["users"]) == 2
    assert data["users"][0]["id"] == "user-1"
    assert data["users"][0]["email"] == "admin1@example.com"
    assert data["users"][1]["id"] == "user-2"


@pytest.mark.asyncio
async def test_list_users_returns_empty_list(client: AsyncClient):
    """GET /api/admin/users returns 200 with empty list when no users exist."""
    with _patch_list([]):
        resp = await client.get("/api/admin/users")
    assert resp.status_code == 200
    assert resp.json()["users"] == []


@pytest.mark.asyncio
async def test_list_users_service_error(client: AsyncClient):
    """GET /api/admin/users returns 502 when Neon returns non-200."""
    with patch(
        "app.routers.admin.neon_auth_service.list_admin_users",
        new_callable=AsyncMock,
        side_effect=NeonAuthServiceError("upstream error"),
    ):
        resp = await client.get("/api/admin/users")
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_list_users_unauthenticated(app):
    """GET /api/admin/users returns 401 when not authenticated."""
    from app.dependencies import require_admin

    # Remove the auth override so the real require_admin is used
    app.dependency_overrides.pop(require_admin, None)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Requested-With": "XMLHttpRequest"},
    ) as ac:
        resp = await ac.get("/api/admin/users")
    assert resp.status_code == 401
    # Restore override for other tests
    from app.dependencies import BetterAuthUser

    async def override_require_admin():
        return BetterAuthUser(email="test-admin@example.com", user_id="test-user-id")

    from app.database import get_db
    from tests.conftest import _BASE_DATABASE_URL  # noqa: F401 — not used, just checking

    app.dependency_overrides[require_admin] = override_require_admin


# ---------------------------------------------------------------------------
# POST /api/admin/users/invite
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_user_happy_path(client: AsyncClient):
    """POST /api/admin/users/invite returns 201 with new user."""
    new_user = AdminUserOut(
        id="user-new",
        email="newadmin@example.com",
        created_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
    )
    with _patch_invite(return_value=new_user):
        resp = await client.post(
            "/api/admin/users/invite",
            json={"email": "newadmin@example.com"},
        )
    assert resp.status_code == 201
    data = resp.json()
    assert data["id"] == "user-new"
    assert data["email"] == "newadmin@example.com"


@pytest.mark.asyncio
async def test_invite_user_invalid_email(client: AsyncClient):
    """POST /api/admin/users/invite returns 422 for invalid email format."""
    resp = await client.post(
        "/api/admin/users/invite",
        json={"email": "not-an-email"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_invite_user_duplicate_email(client: AsyncClient):
    """POST /api/admin/users/invite returns 409 when email already exists."""
    with _patch_invite(side_effect=NeonAuthDuplicateUserError("already exists")):
        resp = await client.post(
            "/api/admin/users/invite",
            json={"email": "existing@example.com"},
        )
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_invite_user_not_configured(client: AsyncClient):
    """POST /api/admin/users/invite returns 503 when Neon Auth is not configured."""
    with _patch_invite(side_effect=NeonAuthNotConfiguredError("not configured")):
        resp = await client.post(
            "/api/admin/users/invite",
            json={"email": "test@example.com"},
        )
    assert resp.status_code == 503
    assert resp.json()["detail"] == "User management not configured"


@pytest.mark.asyncio
async def test_invite_user_service_error(client: AsyncClient):
    """POST /api/admin/users/invite returns 502 on upstream error."""
    with _patch_invite(side_effect=NeonAuthServiceError("upstream error")):
        resp = await client.post(
            "/api/admin/users/invite",
            json={"email": "test@example.com"},
        )
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_invite_user_rate_limited(client: AsyncClient):
    """POST /api/admin/users/invite returns 429 after exceeding rate limit."""
    from app.rate_limiter import admin_invite_limiter

    new_user = AdminUserOut(
        id="user-x",
        email="test@example.com",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    with _patch_invite(return_value=new_user):
        # Exhaust the rate limit
        for _ in range(10):
            await client.post(
                "/api/admin/users/invite",
                json={"email": "test@example.com"},
            )
        resp = await client.post(
            "/api/admin/users/invite",
            json={"email": "test@example.com"},
        )
    assert resp.status_code == 429
    # Reset for subsequent tests (key is current_user.user_id set in conftest)
    admin_invite_limiter.reset("test-user-id")


# ---------------------------------------------------------------------------
# DELETE /api/admin/users/{user_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remove_user_happy_path(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 204 when multiple users exist."""
    with _patch_list([_USER_1, _USER_2]), _patch_remove():
        resp = await client.delete("/api/admin/users/user-2")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_remove_user_self_removal_blocked(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 403 when user_id matches current admin."""
    # The conftest override returns user_id="test-user-id"
    resp = await client.delete("/api/admin/users/test-user-id")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Cannot remove yourself."


@pytest.mark.asyncio
async def test_remove_user_last_admin_blocked(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 409 when only one user remains."""
    with _patch_list([_USER_1]):
        resp = await client.delete("/api/admin/users/user-1")
    assert resp.status_code == 409
    assert "last admin" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_remove_user_not_found(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 404 when user does not exist."""
    with _patch_list([_USER_1, _USER_2]), _patch_remove(
        side_effect=NeonAuthUserNotFoundError("not found")
    ):
        resp = await client.delete("/api/admin/users/nonexistent-id")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_remove_user_list_service_error(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 502 when list call fails."""
    with patch(
        "app.routers.admin.neon_auth_service.list_admin_users",
        new_callable=AsyncMock,
        side_effect=NeonAuthServiceError("upstream error"),
    ):
        resp = await client.delete("/api/admin/users/user-1")
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_remove_user_delete_service_error(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 502 when delete call fails."""
    with _patch_list([_USER_1, _USER_2]), _patch_remove(
        side_effect=NeonAuthServiceError("upstream error")
    ):
        resp = await client.delete("/api/admin/users/user-2")
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_remove_user_delete_not_configured_after_list(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 503 when remove_admin_user raises NeonAuthNotConfiguredError."""
    with _patch_list([_USER_1, _USER_2]), _patch_remove(
        side_effect=NeonAuthNotConfiguredError("not configured")
    ):
        resp = await client.delete("/api/admin/users/user-2")
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_remove_user_post_delete_zero_admins_logs_critical(client: AsyncClient):
    """DELETE /api/admin/users/{id} logs CRITICAL when post-delete re-query finds zero admins.

    This covers the TOCTOU guard — after a successful delete the endpoint
    re-queries and logs critical if no admins remain (should never happen
    in practice, but gives visibility if the pre-check race fires).
    """
    # Pre-delete list has 2 users → guard passes.
    # Post-delete list returns empty → CRITICAL log fires.
    with _patch_list([_USER_1, _USER_2]), _patch_remove(), \
         patch(
             "app.routers.admin.neon_auth_service.list_admin_users",
             new_callable=AsyncMock,
             side_effect=[
                 [_USER_1, _USER_2],  # pre-delete count check
                 [],                  # post-delete re-query → zero remaining
             ],
         ), \
         patch("app.routers.admin.logger") as mock_logger:
        resp = await client.delete("/api/admin/users/user-2")
    assert resp.status_code == 204
    mock_logger.critical.assert_called_once()
    call_args = mock_logger.critical.call_args
    assert call_args.args[0] == "admin_user_removal_left_zero_admins"


@pytest.mark.asyncio
async def test_remove_user_post_delete_requery_service_error_ignored(client: AsyncClient):
    """DELETE /api/admin/users/{id} returns 204 even when the post-delete re-query fails.

    The post-delete verification failure must not mask the successful delete.
    """
    with patch(
        "app.routers.admin.neon_auth_service.list_admin_users",
        new_callable=AsyncMock,
        side_effect=[
            [_USER_1, _USER_2],                  # pre-delete count check
            NeonAuthServiceError("db error"),    # post-delete re-query fails
        ],
    ), _patch_remove():
        resp = await client.delete("/api/admin/users/user-2")
    assert resp.status_code == 204
