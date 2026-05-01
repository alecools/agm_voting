"""
Unit tests for neon_auth_service — all httpx calls are mocked.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Ensure all routers are loaded before the autouse patch_parallel_lot_lookup fixture.
import app.main  # noqa: F401

from app.schemas.admin import AdminUserOut  # noqa: F401 — used in type assertions
from app.services.neon_auth_service import (
    NeonAuthDuplicateUserError,
    NeonAuthNotConfiguredError,
    NeonAuthServiceError,
    NeonAuthUserNotFoundError,
    _get_pghost,
    _resolve_branch_id,
    invite_admin_user,
    list_admin_users,
    remove_admin_user,
)
import app.services.neon_auth_service as _svc_module

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NEON_USER_PAYLOAD = {
    "id": "user-abc",
    "email": "admin@example.com",
    "name": "Admin",
    "emailVerified": True,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
}

_CONFIGURED_SETTINGS = {
    "neon_api_key": "test-api-key",
    "neon_project_id": "test-project-id",
    "neon_branch_id": "test-branch-id",
    "neon_auth_base_url": "https://auth.example.com",
    "allowed_origin": "https://app.example.com",
    "pghost": "",
    "database_url": "postgresql+asyncpg://postgres:postgres@localhost:5432/agm_dev",
}


def _mock_response(status_code: int, json_data: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


def _patch_settings(**overrides):
    """Patch app.services.neon_auth_service.settings with configured values."""
    merged = {**_CONFIGURED_SETTINGS, **overrides}
    m = MagicMock()
    for k, v in merged.items():
        setattr(m, k, v)
    return patch("app.services.neon_auth_service.settings", m)


# ---------------------------------------------------------------------------
# _get_pghost
# ---------------------------------------------------------------------------


def test_get_pghost_returns_pghost_when_set():
    """_get_pghost returns the raw PGHOST value when it is set."""
    with _patch_settings(pghost="ep-cool-name-abc123.us-east-2.aws.neon.tech"):
        result = _get_pghost()
    assert result == "ep-cool-name-abc123.us-east-2.aws.neon.tech"


def test_get_pghost_falls_back_to_database_url():
    """_get_pghost extracts hostname from DATABASE_URL when PGHOST is empty."""
    with _patch_settings(
        pghost="",
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/agm_dev",
    ):
        result = _get_pghost()
    assert result == "localhost"


def test_get_pghost_returns_empty_on_malformed_database_url():
    """_get_pghost returns empty string when DATABASE_URL raises during parsing."""
    m = MagicMock()
    m.pghost = ""

    # Make the urlparse call raise by providing a settings object whose
    # database_url property raises when accessed.
    type(m).database_url = property(lambda self: (_ for _ in ()).throw(Exception("bad url")))

    with patch("app.services.neon_auth_service.settings", m):
        result = _get_pghost()
    assert result == ""


# ---------------------------------------------------------------------------
# _resolve_branch_id — no pghost at all (both PGHOST env var and DATABASE_URL empty)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_branch_id_no_pghost_at_all_raises():
    """_resolve_branch_id raises NeonAuthNotConfiguredError when _get_pghost returns empty.

    This happens when both PGHOST env var is absent and DATABASE_URL yields no hostname
    (e.g. when DATABASE_URL is malformed or the hostname portion is empty).
    """
    _svc_module._cached_branch_id = None

    with _patch_settings(neon_branch_id="", pghost=""), patch(
        "app.services.neon_auth_service._get_pghost", return_value=""
    ):
        with pytest.raises(NeonAuthNotConfiguredError, match="PGHOST is not available"):
            await _resolve_branch_id()


# ---------------------------------------------------------------------------
# _resolve_branch_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_branch_id_uses_static_override():
    """_resolve_branch_id returns neon_branch_id immediately when set (no API call)."""
    # Reset module cache first.
    _svc_module._cached_branch_id = None

    with _patch_settings(neon_branch_id="explicit-branch-id", pghost=""):
        with patch("app.services.neon_auth_service.httpx.AsyncClient") as mock_cls:
            result = await _resolve_branch_id()

    assert result == "explicit-branch-id"
    # No HTTP call should have been made.
    mock_cls.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_branch_id_from_pghost_happy_path():
    """_resolve_branch_id resolves branch ID by matching PGHOST against Neon API."""
    _svc_module._cached_branch_id = None

    branches_payload = {
        "branches": [
            {
                "id": "br-dynamic-id",
                "name": "preview/my-branch",
                "endpoints": [
                    {"host": "ep-cool-name-abc123.us-east-2.aws.neon.tech"}
                ],
            }
        ]
    }
    mock_resp = _mock_response(200, branches_payload)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(
        neon_branch_id="",
        pghost="ep-cool-name-abc123.us-east-2.aws.neon.tech",
    ), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ):
        result = await _resolve_branch_id()

    assert result == "br-dynamic-id"
    assert _svc_module._cached_branch_id == "br-dynamic-id"


@pytest.mark.asyncio
async def test_resolve_branch_id_caching():
    """Second call to _resolve_branch_id does not re-call the Neon API."""
    _svc_module._cached_branch_id = None

    branches_payload = {
        "branches": [
            {
                "id": "br-cached-id",
                "name": "preview/my-branch",
                "endpoints": [
                    {"host": "ep-cached-host-abc.us-east-2.aws.neon.tech"}
                ],
            }
        ]
    }
    mock_resp = _mock_response(200, branches_payload)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(
        neon_branch_id="",
        pghost="ep-cached-host-abc.us-east-2.aws.neon.tech",
    ), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ):
        first = await _resolve_branch_id()
        second = await _resolve_branch_id()

    assert first == "br-cached-id"
    assert second == "br-cached-id"
    # API should only have been called once.
    assert mock_client.get.call_count == 1


@pytest.mark.asyncio
async def test_resolve_branch_id_pghost_not_set_raises():
    """_resolve_branch_id raises NeonAuthNotConfiguredError when PGHOST is absent
    and no Neon branch endpoint matches the localhost DATABASE_URL hostname."""
    _svc_module._cached_branch_id = None

    # When pghost is empty the code falls back to DATABASE_URL hostname
    # (localhost in dev). The Neon API is called but finds no matching branch.
    branches_payload = {"branches": []}
    mock_resp = _mock_response(200, branches_payload)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(
        neon_branch_id="",
        pghost="",
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/agm_dev",
    ), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ):
        with pytest.raises(NeonAuthNotConfiguredError, match="No Neon branch endpoint matches"):
            await _resolve_branch_id()


@pytest.mark.asyncio
async def test_resolve_branch_id_no_matching_branch_raises():
    """_resolve_branch_id raises NeonAuthNotConfiguredError when no branch matches PGHOST."""
    _svc_module._cached_branch_id = None

    branches_payload = {
        "branches": [
            {
                "id": "br-other",
                "name": "main",
                "endpoints": [
                    {"host": "ep-other-host-xyz.us-east-2.aws.neon.tech"}
                ],
            }
        ]
    }
    mock_resp = _mock_response(200, branches_payload)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(
        neon_branch_id="",
        pghost="ep-totally-different.us-east-2.aws.neon.tech",
    ), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ):
        with pytest.raises(NeonAuthNotConfiguredError, match="No Neon branch endpoint matches"):
            await _resolve_branch_id()


@pytest.mark.asyncio
async def test_resolve_branch_id_api_key_missing_raises():
    """_resolve_branch_id raises NeonAuthNotConfiguredError when NEON_API_KEY absent."""
    _svc_module._cached_branch_id = None

    with _patch_settings(
        neon_branch_id="",
        neon_api_key="",
        pghost="ep-some-host.us-east-2.aws.neon.tech",
    ):
        with pytest.raises(NeonAuthNotConfiguredError):
            await _resolve_branch_id()


@pytest.mark.asyncio
async def test_resolve_branch_id_branches_api_non_200_raises():
    """_resolve_branch_id raises NeonAuthNotConfiguredError when branches API fails."""
    _svc_module._cached_branch_id = None

    mock_resp = _mock_response(500)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(
        neon_branch_id="",
        pghost="ep-some-host.us-east-2.aws.neon.tech",
    ), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ):
        with pytest.raises(NeonAuthNotConfiguredError, match="branches API returned 500"):
            await _resolve_branch_id()


# ---------------------------------------------------------------------------
# list_admin_users
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_admin_users_returns_parsed_list():
    """list_admin_users returns a parsed AdminUserOut list on success."""
    mock_resp = _mock_response(200, {"users": [_NEON_USER_PAYLOAD]})
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        result = await list_admin_users()

    assert len(result) == 1
    assert result[0].id == "user-abc"
    assert result[0].email == "admin@example.com"
    assert isinstance(result[0].created_at, datetime)


@pytest.mark.asyncio
async def test_list_admin_users_empty_list():
    """list_admin_users returns empty list when Neon returns no users."""
    mock_resp = _mock_response(200, {"users": []})
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        result = await list_admin_users()

    assert result == []


@pytest.mark.asyncio
async def test_list_admin_users_config_missing():
    """list_admin_users raises NeonAuthNotConfiguredError when API key is absent."""
    m = MagicMock()
    m.neon_api_key = ""
    m.neon_project_id = "test-project-id"
    m.neon_branch_id = "test-branch-id"
    with patch("app.services.neon_auth_service.settings", m):
        with pytest.raises(NeonAuthNotConfiguredError):
            await list_admin_users()


@pytest.mark.asyncio
async def test_list_admin_users_project_id_missing():
    """list_admin_users raises NeonAuthNotConfiguredError when project_id absent."""
    m = MagicMock()
    m.neon_api_key = "key"
    m.neon_project_id = ""
    m.neon_branch_id = "branch"
    with patch("app.services.neon_auth_service.settings", m):
        with pytest.raises(NeonAuthNotConfiguredError):
            await list_admin_users()


@pytest.mark.asyncio
async def test_list_admin_users_resolve_branch_raises_not_configured():
    """list_admin_users propagates NeonAuthNotConfiguredError from _resolve_branch_id."""
    m = MagicMock()
    m.neon_api_key = "key"
    m.neon_project_id = "project"
    m.neon_branch_id = ""
    with patch("app.services.neon_auth_service.settings", m), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(side_effect=NeonAuthNotConfiguredError("no branch")),
    ):
        with pytest.raises(NeonAuthNotConfiguredError):
            await list_admin_users()


@pytest.mark.asyncio
async def test_list_admin_users_non_200_raises_service_error():
    """list_admin_users raises NeonAuthServiceError on non-200 from Neon."""
    mock_resp = _mock_response(500)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthServiceError):
            await list_admin_users()


# ---------------------------------------------------------------------------
# invite_admin_user
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invite_admin_user_happy_path():
    """invite_admin_user creates user and triggers password reset; returns AdminUserOut."""
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    reset_resp = _mock_response(200, {"status": "ok"})

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[create_resp, reset_resp])

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        result = await invite_admin_user("admin@example.com", "https://app.example.com")

    assert result.id == "user-abc"
    assert result.email == "admin@example.com"
    # Random password must not be present in the returned value
    assert not hasattr(result, "password")


@pytest.mark.asyncio
async def test_invite_admin_user_create_returns_200():
    """invite_admin_user handles 200 (not just 201) from Neon create."""
    create_resp = _mock_response(200, _NEON_USER_PAYLOAD)
    reset_resp = _mock_response(200, {"status": "ok"})

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[create_resp, reset_resp])

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        result = await invite_admin_user("admin@example.com", "https://app.example.com")

    assert result.id == "user-abc"


@pytest.mark.asyncio
async def test_invite_admin_user_duplicate_raises():
    """invite_admin_user raises NeonAuthDuplicateUserError when Neon returns 409."""
    create_resp = _mock_response(409)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=create_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthDuplicateUserError):
            await invite_admin_user("existing@example.com", "https://app.example.com")


@pytest.mark.asyncio
async def test_invite_admin_user_create_non_2xx_raises_service_error():
    """invite_admin_user raises NeonAuthServiceError on non-2xx create response."""
    create_resp = _mock_response(500)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=create_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthServiceError):
            await invite_admin_user("test@example.com", "https://app.example.com")


@pytest.mark.asyncio
async def test_invite_admin_user_password_reset_fails():
    """invite_admin_user raises NeonAuthServiceError when password-reset call fails."""
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    reset_resp = _mock_response(500)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[create_resp, reset_resp])

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthServiceError):
            await invite_admin_user("test@example.com", "https://app.example.com")


@pytest.mark.asyncio
async def test_invite_admin_user_password_reset_201_accepted():
    """invite_admin_user accepts 201 from the password-reset endpoint."""
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    reset_resp = _mock_response(201, {"status": "ok"})

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[create_resp, reset_resp])

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        result = await invite_admin_user("test@example.com", "https://app.example.com")

    assert result.id == "user-abc"


@pytest.mark.asyncio
async def test_invite_admin_user_not_configured():
    """invite_admin_user raises NeonAuthNotConfiguredError when API key is absent."""
    m = MagicMock()
    m.neon_api_key = ""
    m.neon_project_id = "p"
    m.neon_branch_id = "b"
    with patch("app.services.neon_auth_service.settings", m):
        with pytest.raises(NeonAuthNotConfiguredError):
            await invite_admin_user("test@example.com", "https://app.example.com")


# ---------------------------------------------------------------------------
# remove_admin_user
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remove_admin_user_happy_path():
    """remove_admin_user returns normally on success (200 from Neon)."""
    mock_resp = _mock_response(200)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.delete = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        await remove_admin_user("user-abc")  # should not raise


@pytest.mark.asyncio
async def test_remove_admin_user_204_accepted():
    """remove_admin_user accepts 204 No Content from Neon."""
    mock_resp = _mock_response(204)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.delete = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        await remove_admin_user("user-abc")  # should not raise


@pytest.mark.asyncio
async def test_remove_admin_user_not_found():
    """remove_admin_user raises NeonAuthUserNotFoundError when Neon returns 404."""
    mock_resp = _mock_response(404)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.delete = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthUserNotFoundError):
            await remove_admin_user("nonexistent-id")


@pytest.mark.asyncio
async def test_remove_admin_user_service_error():
    """remove_admin_user raises NeonAuthServiceError on non-200/404 response."""
    mock_resp = _mock_response(500)
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.delete = AsyncMock(return_value=mock_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthServiceError):
            await remove_admin_user("user-abc")


@pytest.mark.asyncio
async def test_remove_admin_user_not_configured():
    """remove_admin_user raises NeonAuthNotConfiguredError when API key is absent."""
    m = MagicMock()
    m.neon_api_key = ""
    m.neon_project_id = "p"
    m.neon_branch_id = "b"
    with patch("app.services.neon_auth_service.settings", m):
        with pytest.raises(NeonAuthNotConfiguredError):
            await remove_admin_user("user-abc")
