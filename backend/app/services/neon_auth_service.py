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
"""
from __future__ import annotations

import secrets
from urllib.parse import urlparse

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.logging_config import get_logger
from app.schemas.admin import AdminUserOut

logger = get_logger(__name__)


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
        resp = await client.get(
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
    try:
        # neon_auth."user" is a schema managed by Neon Auth (Better Auth), not by
        # SQLAlchemy ORM models — there is no SQLAlchemy model for it, and defining
        # one would couple the app to Neon Auth's internal schema.
        result = await db.execute(
            text(  # nosemgrep: raw-sql-requires-comment
                'SELECT id::text, email, "createdAt" FROM neon_auth."user" ORDER BY "createdAt"'
            )
        )
        rows = result.fetchall()
    except Exception as exc:
        logger.error("neon_list_users_db_failed", error=str(exc))
        raise NeonAuthServiceError("Failed to list admin users from database") from exc
    return [
        AdminUserOut(
            id=row.id,
            email=row.email,
            created_at=row.createdAt,
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
        resp = await client.post(
            url,
            headers={**_auth_headers(), "Content-Type": "application/json"},
            json={"email": email, "name": name, "password": temp_password},
            timeout=15.0,
        )

    # Discard temp_password immediately — do not log or store it.
    del temp_password

    if resp.status_code == 409:
        raise NeonAuthDuplicateUserError(f"User with email {email} already exists")
    if resp.status_code not in (200, 201):
        logger.error("neon_create_user_failed", status=resp.status_code)
        raise NeonAuthServiceError(
            f"Neon Auth returned {resp.status_code} creating user"
        )

    user_data = resp.json()

    # Trigger password-reset email so the invitee can set their password.
    neon_auth_base_url = settings.neon_auth_base_url.rstrip("/")
    reset_url = f"{neon_auth_base_url}/request-password-reset"
    redirect_to = f"{redirect_origin}/admin/login"

    async with httpx.AsyncClient() as client:
        reset_resp = await client.post(
            reset_url,
            json={"email": email, "redirectTo": redirect_to},
            timeout=15.0,
        )

    if reset_resp.status_code not in (200, 201):
        logger.error("neon_password_reset_failed", status=reset_resp.status_code, email=email)
        raise NeonAuthServiceError(
            f"Password reset email failed with status {reset_resp.status_code}"
        )

    return AdminUserOut(
        id=user_data["id"],
        email=user_data["email"],
        created_at=user_data["createdAt"],
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
        resp = await client.delete(url, headers=_auth_headers(), timeout=15.0)
    if resp.status_code == 404:
        raise NeonAuthUserNotFoundError(f"User {user_id} not found")
    if resp.status_code not in (200, 204):
        logger.error("neon_delete_user_failed", status=resp.status_code, user_id=user_id)
        raise NeonAuthServiceError(
            f"Neon Auth returned {resp.status_code} deleting user {user_id}"
        )
