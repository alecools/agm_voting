"""
Neon Auth management API service for admin user management.

This module handles listing, creating, and deleting admin users.

Listing users
-------------
The Neon console management API (`GET /api/v2/projects/{id}/branches/{id}/auth/users`)
only supports POST (create) — GET returns HTTP 405.  Therefore `list_admin_users`
queries the `neon_auth.user` table in the Neon database directly via the provided
SQLAlchemy session.  This table is populated and maintained by the Neon Auth service.

Creating and deleting users
----------------------------
These operations still go through the Neon console management API:
  POST   /api/v2/projects/{id}/branches/{id}/auth/users  — create user
  DELETE /api/v2/projects/{id}/branches/{id}/auth/users/{id} — delete user

The NEON_API_KEY is a server-side secret. It is never returned in any API response,
never logged, and never sent to the frontend.

Branch ID resolution
--------------------
NEON_BRANCH_ID may be set as a static env var override (useful for local dev and tests).
When absent, the branch ID is resolved dynamically by calling the Neon management API
to list all endpoints and matching against the PGHOST env var injected by the Neon-Vercel
integration.  The result is cached for the lifetime of the Lambda instance.

Retry logic
-----------
All Neon management API calls are wrapped in ``_neon_api_with_retry``, which retries
once on an HTTP 5xx response after a 1-second delay.  This handles transient Neon
serverless cold-start 503s without adding meaningful latency on success.
"""
from __future__ import annotations

import asyncio
import secrets
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy import Column, MetaData, String, Table, cast, select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.logging_config import get_logger
from app.schemas.admin import AdminUserOut

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# neon_auth.user table definition (SQLAlchemy Core reflection)
# ---------------------------------------------------------------------------
# neon_auth."user" is managed by Neon Auth (Better Auth) — it is not part of
# the application's SQLAlchemy ORM.  We define it as a Core Table so queries
# are expressed without raw SQL strings.
_neon_auth_metadata = MetaData(schema="neon_auth")
_neon_auth_user_table = Table(
    "user",
    _neon_auth_metadata,
    Column("id", String),
    Column("email", String),
    Column("createdAt", String),
)


# ---------------------------------------------------------------------------
# Custom exception hierarchy
# ---------------------------------------------------------------------------


class NeonAuthNotConfiguredError(Exception):
    """Raised when NEON_API_KEY, NEON_PROJECT_ID, or branch ID cannot be resolved."""


class NeonAuthDuplicateUserError(Exception):
    """Raised when the email already exists in Neon Auth (409 from management API)."""


class NeonAuthUserNotFoundError(Exception):
    """Raised when the target user does not exist (404 from management API)."""


class NeonAuthServiceError(Exception):
    """Raised on any other non-2xx response from the Neon management API."""


# ---------------------------------------------------------------------------
# Branch ID resolution
# ---------------------------------------------------------------------------

# Module-level cache — the branch does not change during a Lambda's lifetime.
_cached_branch_id: str | None = None


def _get_pghost() -> str:
    """Extract the endpoint hostname from PGHOST or DATABASE_URL.

    Returns the raw PGHOST value if set, otherwise falls back to extracting
    the hostname from DATABASE_URL.  Returns an empty string if neither
    yields a usable host.
    """
    if settings.pghost:
        return settings.pghost
    # Fallback: parse the hostname out of DATABASE_URL.
    try:
        parsed = urlparse(settings.database_url)
        return parsed.hostname or ""
    except Exception:
        return ""


async def _resolve_branch_id() -> str:
    """Return the Neon branch ID for the current deployment.

    Resolution order:
    1. Return ``settings.neon_branch_id`` immediately if it is set (explicit
       override — used in tests and local dev).
    2. Return the module-level cache if already resolved this instance.
    3. Call the Neon branches API, find the branch whose endpoint host matches
       PGHOST, cache and return its ID.

    Raises NeonAuthNotConfiguredError when:
    - Neither NEON_BRANCH_ID nor PGHOST is available.
    - No branch endpoint matches PGHOST.
    """
    global _cached_branch_id  # noqa: PLW0603

    # 1. Explicit static override (tests, local dev, demo env).
    if settings.neon_branch_id:
        return settings.neon_branch_id

    # 2. Already resolved this instance.
    if _cached_branch_id is not None:
        return _cached_branch_id

    # 3. Resolve dynamically via the Neon management API.
    pghost = _get_pghost()
    if not pghost:
        raise NeonAuthNotConfiguredError(
            "Cannot resolve Neon branch ID: NEON_BRANCH_ID is not set and "
            "PGHOST is not available."
        )

    if not settings.neon_api_key or not settings.neon_project_id:
        raise NeonAuthNotConfiguredError("User management not configured")

    # The /branches API does NOT embed endpoint data in its response — each
    # branch object has an empty "endpoints" list.  Use the dedicated
    # /endpoints API which returns all endpoints with their branch_id and host.
    url = f"https://console.neon.tech/api/v2/projects/{settings.neon_project_id}/endpoints"
    async with httpx.AsyncClient() as client:
        resp = await _neon_api_with_retry(
            client,
            "GET",
            url,
            headers={"Authorization": f"Bearer {settings.neon_api_key}"},
            timeout=15.0,
        )

    if resp.status_code != 200:
        logger.error("neon_list_endpoints_failed", status=resp.status_code)
        raise NeonAuthNotConfiguredError(
            f"Neon endpoints API returned {resp.status_code}; cannot resolve branch ID"
        )

    endpoints = resp.json().get("endpoints", [])
    for endpoint in endpoints:
        host = endpoint.get("host", "")
        if host and pghost.startswith(host.split(".")[0]):
            _cached_branch_id = endpoint["branch_id"]
            return _cached_branch_id

    raise NeonAuthNotConfiguredError(
        f"No Neon branch endpoint matches PGHOST '{pghost}'"
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _check_api_configured() -> None:
    """Raise NeonAuthNotConfiguredError if NEON_API_KEY or NEON_PROJECT_ID are absent."""
    if not settings.neon_api_key or not settings.neon_project_id:
        raise NeonAuthNotConfiguredError("User management not configured")


async def _management_base_url() -> str:
    branch_id = await _resolve_branch_id()
    return (
        f"https://console.neon.tech/api/v2/projects/{settings.neon_project_id}"
        f"/branches/{branch_id}/auth"
    )


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.neon_api_key}"}


_NEON_RETRY_DELAY = 1.0  # seconds to wait before the single retry on 5xx


async def _neon_api_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs,
) -> httpx.Response:
    """Call the Neon management API and retry once on HTTP 5xx.

    Uses the method-specific AsyncClient helpers (``client.get``, ``client.post``,
    ``client.delete``) so existing mock setups that stub those methods continue to
    work without modification.

    On a transient 503 (Neon serverless cold start) this adds at most
    ``_NEON_RETRY_DELAY`` + 15s overhead before the caller sees the failure.
    On success the retry path is never taken.
    """
    caller = getattr(client, method.lower())
    resp = await caller(url, **kwargs)
    if resp.status_code >= 500:
        await asyncio.sleep(_NEON_RETRY_DELAY)
        resp = await caller(url, **kwargs)
    return resp


# ---------------------------------------------------------------------------
# Service functions
# ---------------------------------------------------------------------------


async def list_admin_users(db: AsyncSession) -> list[AdminUserOut]:
    """Return all admin users by querying the neon_auth.user table directly.

    The Neon console management API does not expose a list-users endpoint
    (GET /auth/users returns HTTP 405 — only POST is supported).  We query
    the `neon_auth.user` table, which the Neon Auth service keeps in sync,
    as the authoritative source of truth for admin accounts.

    Raises NeonAuthServiceError on any database error.
    """
    t = _neon_auth_user_table
    stmt = sa_select(
        cast(t.c.id, String).label("id"),
        t.c.email,
        t.c["createdAt"],
    ).order_by(t.c["createdAt"])
    try:
        result = await db.execute(stmt)
        rows = result.mappings().all()
    except Exception as exc:
        logger.error("neon_list_users_db_failed", error=str(exc))
        raise NeonAuthServiceError("Failed to list admin users from database") from exc
    return [
        AdminUserOut(
            id=row["id"],
            email=row["email"],
            created_at=row["createdAt"],
        )
        for row in rows
    ]


async def invite_admin_user(email: str, redirect_origin: str) -> AdminUserOut:
    """Create a user in Neon Auth and trigger a password-reset email.

    Steps:
      1. POST /users to create the account with a random discarded password.
      2. POST {neon_auth_base_url}/request-password-reset to send the setup email.

    Raises NeonAuthNotConfiguredError if config is absent.
    Raises NeonAuthDuplicateUserError if the email already exists (Neon returns 409).
    Raises NeonAuthServiceError on other non-2xx responses.
    """
    _check_api_configured()

    # Generate a cryptographically random password — discarded immediately after use.
    # The invitee sets their own password via the password-reset email.
    temp_password = secrets.token_urlsafe(32)  # nosemgrep: no-hardcoded-secrets -- random temporary credential, discarded immediately after API call

    # Neon management API requires name to have length >= 1.
    # Use the local part of the email address (before @) as a sensible default.
    name = email.split("@")[0]

    base_url = await _management_base_url()
    url = f"{base_url}/users"
    async with httpx.AsyncClient() as client:
        resp = await _neon_api_with_retry(
            client,
            "POST",
            url,
            headers={**_auth_headers(), "Content-Type": "application/json"},
            json={"email": email, "name": name, "password": temp_password},
            timeout=15.0,
        )

    # Discard temp_password immediately — do not log or store it.
    del temp_password

    if resp.status_code in (409, 422):
        # Neon Auth management API returns 409 for duplicate users in most cases,
        # but some versions return 422 (Unprocessable Entity) for the same condition.
        # Both are treated as "user already exists" to prevent a 502 bubble-up.
        raise NeonAuthDuplicateUserError(f"User with email {email} already exists")
    if resp.status_code == 400:
        # Current Neon Auth management API versions return HTTP 400 for duplicate
        # users with error code "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL".  Check the
        # body so we only treat the known duplicate code as a duplicate — any other
        # 400 (e.g. malformed payload) is re-raised as a service error.
        try:
            error_code = resp.json().get("code", "")
        except Exception:
            error_code = ""
        if "USER_ALREADY_EXISTS" in error_code:
            raise NeonAuthDuplicateUserError(f"User with email {email} already exists")
        logger.error("neon_create_user_failed", status=resp.status_code)
        raise NeonAuthServiceError(
            f"Neon Auth returned {resp.status_code} creating user"
        )
    if resp.status_code not in (200, 201):
        logger.error("neon_create_user_failed", status=resp.status_code)
        raise NeonAuthServiceError(
            f"Neon Auth returned {resp.status_code} creating user"
        )

    user_data = resp.json()

    # Trigger password-reset email so the invitee can set their password.
    # Pass both the Origin header (required by Neon Auth for trusted-origin validation)
    # and redirectTo so the reset link in the email points back to the correct app URL.
    # redirectTo must match a registered trusted origin — using the same
    # /admin/login path that auth_proxy.py uses for user-initiated password resets
    # ensures consistency and satisfies Neon Auth's origin check.
    neon_auth_base_url = settings.neon_auth_base_url.rstrip("/")
    reset_url = f"{neon_auth_base_url}/request-password-reset"
    redirect_to = f"{redirect_origin}/admin/login"

    async with httpx.AsyncClient() as client:
        reset_resp = await _neon_api_with_retry(
            client,
            "POST",
            reset_url,
            headers={"Content-Type": "application/json", "Origin": redirect_origin},
            json={"email": email, "redirectTo": redirect_to},
            timeout=15.0,
        )

    if reset_resp.status_code not in (200, 201):
        logger.error(
            "neon_password_reset_failed",
            status=reset_resp.status_code,
            body=reset_resp.text[:200],
            email=email,
        )
        # Clean up the orphaned account so a re-invite is possible.
        # Wrap in try/except so a delete failure does not mask the original error.
        try:
            await remove_admin_user(user_data["id"])
        except Exception as cleanup_exc:
            logger.warning(
                "neon_orphan_cleanup_failed",
                user_id=user_data["id"],
                error=str(cleanup_exc),
            )
        raise NeonAuthServiceError(
            f"Password reset email failed with status {reset_resp.status_code}"
        )

    # The Neon Auth management API POST /auth/users response only contains {"id": "..."}.
    # The email is already known (it was the input parameter) and createdAt is not
    # returned by the API, so we use the current UTC time as an approximation.
    return AdminUserOut(
        id=user_data["id"],
        email=email,
        created_at=datetime.now(timezone.utc),
    )


async def remove_admin_user(user_id: str) -> None:
    """Delete a user from Neon Auth.

    Raises NeonAuthNotConfiguredError if config is absent.
    Raises NeonAuthUserNotFoundError if the user does not exist (Neon returns 404).
    Raises NeonAuthServiceError on other non-2xx responses.
    """
    _check_api_configured()
    base_url = await _management_base_url()
    url = f"{base_url}/users/{user_id}"
    async with httpx.AsyncClient() as client:
        resp = await _neon_api_with_retry(
            client, "DELETE", url, headers=_auth_headers(), timeout=15.0
        )
    if resp.status_code == 404:
        raise NeonAuthUserNotFoundError(f"User {user_id} not found")
    if resp.status_code not in (200, 204):
        logger.error("neon_delete_user_failed", status=resp.status_code, user_id=user_id)
        raise NeonAuthServiceError(
            f"Neon Auth returned {resp.status_code} deleting user {user_id}"
        )
