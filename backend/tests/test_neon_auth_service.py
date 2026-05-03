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

# The Neon Auth management API POST /auth/users response only contains {"id": "..."}.
# email, name, createdAt, etc. are NOT returned by the API.
_NEON_USER_PAYLOAD = {
    "id": "user-abc",
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
    """_resolve_branch_id resolves branch ID by matching PGHOST against Neon endpoints API."""
    _svc_module._cached_branch_id = None

    # The /endpoints API returns a flat list of endpoints; each has branch_id and host.
    # The /branches API does NOT embed endpoint data — this is the root cause of the
    # original 503: the code previously called /branches which always returned empty
    # endpoint lists, so no branch was ever matched.
    endpoints_payload = {
        "endpoints": [
            {
                "id": "ep-cool-name-abc123",
                "branch_id": "br-dynamic-id",
                "host": "ep-cool-name-abc123.us-east-2.aws.neon.tech",
            }
        ]
    }
    mock_resp = _mock_response(200, endpoints_payload)
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
    # Verify it called /endpoints, not /branches
    call_url = mock_client.get.call_args[0][0]
    assert "/endpoints" in call_url
    assert "/branches" not in call_url


@pytest.mark.asyncio
async def test_resolve_branch_id_caching():
    """Second call to _resolve_branch_id does not re-call the Neon API."""
    _svc_module._cached_branch_id = None

    endpoints_payload = {
        "endpoints": [
            {
                "id": "ep-cached-host-abc",
                "branch_id": "br-cached-id",
                "host": "ep-cached-host-abc.us-east-2.aws.neon.tech",
            }
        ]
    }
    mock_resp = _mock_response(200, endpoints_payload)
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
    and no Neon endpoint matches the localhost DATABASE_URL hostname."""
    _svc_module._cached_branch_id = None

    # When pghost is empty the code falls back to DATABASE_URL hostname
    # (localhost in dev). The Neon API is called but finds no matching endpoint.
    endpoints_payload = {"endpoints": []}
    mock_resp = _mock_response(200, endpoints_payload)
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
    """_resolve_branch_id raises NeonAuthNotConfiguredError when no endpoint matches PGHOST."""
    _svc_module._cached_branch_id = None

    endpoints_payload = {
        "endpoints": [
            {
                "id": "ep-other-host-xyz",
                "branch_id": "br-other",
                "host": "ep-other-host-xyz.us-east-2.aws.neon.tech",
            }
        ]
    }
    mock_resp = _mock_response(200, endpoints_payload)
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
        with pytest.raises(NeonAuthNotConfiguredError, match="endpoints API returned 500"):
            await _resolve_branch_id()


# ---------------------------------------------------------------------------
# list_admin_users — queries neon_auth.user via DB (no management API call)
# ---------------------------------------------------------------------------


def _make_row(id: str, email: str, created_at: datetime):
    """Build a mock mapping row with the columns returned by list_admin_users.

    The implementation uses result.mappings().all(), so each row must support
    dict-style access with string keys ("id", "email", "createdAt").
    """
    return {"id": id, "email": email, "createdAt": created_at}


def _make_mock_db(rows):
    """Return an AsyncMock that mimics an AsyncSession for list_admin_users.

    The implementation calls result.mappings().all(), so we chain the mocks
    accordingly: execute() → mappings() → all().
    """
    mock_mappings = MagicMock()
    mock_mappings.all.return_value = rows
    mock_result = MagicMock()
    mock_result.mappings.return_value = mock_mappings
    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(return_value=mock_result)
    return mock_db


@pytest.mark.asyncio
async def test_list_admin_users_returns_parsed_list():
    """list_admin_users returns a parsed AdminUserOut list on success."""
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = [_make_row("user-abc", "admin@example.com", ts)]
    mock_db = _make_mock_db(rows)

    result = await list_admin_users(mock_db)

    assert len(result) == 1
    assert result[0].id == "user-abc"
    assert result[0].email == "admin@example.com"
    assert isinstance(result[0].created_at, datetime)


@pytest.mark.asyncio
async def test_list_admin_users_empty_list():
    """list_admin_users returns empty list when neon_auth.user has no rows."""
    mock_db = _make_mock_db([])

    result = await list_admin_users(mock_db)

    assert result == []


@pytest.mark.asyncio
async def test_list_admin_users_multiple_users():
    """list_admin_users returns all rows in creation order."""
    ts1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ts2 = datetime(2026, 2, 1, tzinfo=timezone.utc)
    rows = [
        _make_row("user-1", "admin1@example.com", ts1),
        _make_row("user-2", "admin2@example.com", ts2),
    ]
    mock_db = _make_mock_db(rows)

    result = await list_admin_users(mock_db)

    assert len(result) == 2
    assert result[0].id == "user-1"
    assert result[1].id == "user-2"


@pytest.mark.asyncio
async def test_list_admin_users_db_error_raises_service_error():
    """list_admin_users raises NeonAuthServiceError when the DB query fails."""
    mock_db = AsyncMock()
    mock_db.execute = AsyncMock(side_effect=Exception("connection refused"))

    with pytest.raises(NeonAuthServiceError, match="Failed to list admin users"):
        await list_admin_users(mock_db)


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
    # email comes from the input parameter — the API only returns {"id": "..."}
    assert result.email == "admin@example.com"
    # created_at is set to now() since the API does not return it
    assert isinstance(result.created_at, datetime)
    # Random password must not be present in the returned value
    assert not hasattr(result, "password")

    # The create call must send name=local-part-of-email (Neon requires length >= 1).
    create_call_kwargs = mock_client.post.call_args_list[0].kwargs
    assert create_call_kwargs["json"]["name"] == "admin"

    # The reset call must send Origin header (required by Neon Auth) and redirectTo
    # pointing to /admin/login on the same origin — matching the auth_proxy.py pattern
    # so the invite email links back to the correct deployment's admin login page.
    reset_call_kwargs = mock_client.post.call_args_list[1].kwargs
    assert reset_call_kwargs["headers"].get("Origin") == "https://app.example.com"
    assert reset_call_kwargs["json"]["redirectTo"] == "https://app.example.com/admin/login"
    assert reset_call_kwargs["json"]["email"] == "admin@example.com"


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
async def test_invite_admin_user_duplicate_422_raises():
    """invite_admin_user raises NeonAuthDuplicateUserError when Neon returns 422.

    Some Neon Auth versions return 422 (Unprocessable Entity) instead of 409
    when the email already exists.  Both must map to NeonAuthDuplicateUserError
    so the router can return 409 rather than 502.
    """
    create_resp = _mock_response(422)

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
async def test_invite_admin_user_duplicate_400_user_already_exists_raises():
    """invite_admin_user raises NeonAuthDuplicateUserError when Neon returns HTTP 400
    with error code USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL.

    The current Neon Auth management API returns 400 (not 409/422) for duplicates.
    """
    create_resp = _mock_response(
        400, {"code": "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "message": "User already exists."}
    )

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
async def test_invite_admin_user_400_non_duplicate_code_raises_service_error():
    """invite_admin_user raises NeonAuthServiceError when Neon returns HTTP 400
    with an error code that is NOT USER_ALREADY_EXISTS (e.g. malformed payload).
    """
    create_resp = _mock_response(400, {"code": "INVALID_REQUEST", "message": "Bad payload"})

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
async def test_invite_admin_user_400_json_parse_error_raises_service_error():
    """invite_admin_user raises NeonAuthServiceError when Neon returns HTTP 400
    and the response body cannot be parsed as JSON.
    """
    create_resp = MagicMock()
    create_resp.status_code = 400
    create_resp.json.side_effect = Exception("not valid json")

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
    """invite_admin_user raises NeonAuthServiceError when password-reset call fails.

    When the reset call fails, the service attempts to delete the just-created
    user to avoid leaving an orphaned account (SECURITY-4).

    _neon_api_with_retry retries once on 5xx, so we provide two 500 responses
    for the reset POST (first attempt + one retry), then a 204 for the cleanup delete.
    """
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    reset_resp_1 = _mock_response(500)
    reset_resp_2 = _mock_response(500)  # retry response
    delete_resp = _mock_response(204)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[create_resp, reset_resp_1, reset_resp_2])
    mock_client.delete = AsyncMock(return_value=delete_resp)

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ):
        with pytest.raises(NeonAuthServiceError):
            await invite_admin_user("test@example.com", "https://app.example.com")

    # Verify the orphan cleanup delete was attempted with the created user's ID
    assert mock_client.delete.call_count == 1


@pytest.mark.asyncio
async def test_invite_admin_user_password_reset_fails_cleanup_failure_logs_warning():
    """invite_admin_user logs a warning if the orphan cleanup delete also fails.

    The cleanup failure must not mask the original NeonAuthServiceError.
    The cleanup calls _neon_api_with_retry which retries once on 5xx, so we
    provide two 500 responses (first attempt + one retry).
    """
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    # Two 500 responses for the reset POST: first attempt + one retry.
    reset_resp_1 = _mock_response(500)
    reset_resp_2 = _mock_response(500)
    # Two 500 responses for the cleanup delete: first attempt + one retry.
    # Both fail → NeonAuthServiceError raised inside remove_admin_user,
    # which is caught by the outer try/except and logged as a warning.
    delete_resp_1 = _mock_response(500)
    delete_resp_2 = _mock_response(500)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=[create_resp, reset_resp_1, reset_resp_2])
    mock_client.delete = AsyncMock(side_effect=[delete_resp_1, delete_resp_2])

    with _patch_settings(), patch(
        "app.services.neon_auth_service.httpx.AsyncClient", return_value=mock_client
    ), patch(
        "app.services.neon_auth_service._resolve_branch_id",
        AsyncMock(return_value="test-branch-id"),
    ), patch("app.services.neon_auth_service.logger") as mock_logger:
        with pytest.raises(NeonAuthServiceError):
            await invite_admin_user("test@example.com", "https://app.example.com")

    # A warning must be logged if cleanup itself fails
    mock_logger.warning.assert_called_once()
    call_args = mock_logger.warning.call_args
    assert call_args.args[0] == "neon_orphan_cleanup_failed"


@pytest.mark.asyncio
async def test_invite_admin_user_password_reset_400_missing_origin_raises():
    """invite_admin_user raises NeonAuthServiceError when reset returns 400 MISSING_ORIGIN.

    Neon Auth returns 400 {"code":"MISSING_ORIGIN"} when Origin is absent and
    redirectTo is not provided.  This should not silently swallow the error —
    NeonAuthServiceError is raised so the router returns 502 to signal that the
    user was created but the invite email could not be sent.
    """
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    reset_resp = _mock_response(400)
    reset_resp.text = '{"code":"MISSING_ORIGIN","message":"Origin header is required"}'

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
async def test_invite_admin_user_password_reset_403_invalid_redirect_raises():
    """invite_admin_user raises NeonAuthServiceError when reset returns 403 INVALID_REDIRECTURL.

    Neon Auth returns 403 {"code":"INVALID_REDIRECTURL"} when the redirectTo URL is
    not in the registered trusted origins.  The service must not send redirectTo; this
    test ensures that if it does (regression), the 403 is surfaced rather than swallowed.
    """
    create_resp = _mock_response(201, _NEON_USER_PAYLOAD)
    reset_resp = _mock_response(403)
    reset_resp.text = '{"code":"INVALID_REDIRECTURL","message":"Invalid redirectURL"}'

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
