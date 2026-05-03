"""
Shared FastAPI dependencies for the AGM Voting App.

require_admin: validates a Better Auth session by calling the Neon Auth
              get-session endpoint and returns the authenticated user.
get_client_ip: extracts the real client IP from X-Forwarded-For (Vercel proxy).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx
from fastapi import Depends, HTTPException, Request

from app.config import settings

# Neon Auth is serverless; cold starts can cause transient 401s on /get-session.
# Retry up to this many times with a short delay before propagating the error.
_GET_SESSION_MAX_RETRIES = 3
_GET_SESSION_RETRY_DELAY = 1.0  # seconds


def get_client_ip(request: Request) -> str:
    """Return the real client IP address, honouring X-Forwarded-For from Vercel proxy.

    Vercel sets X-Forwarded-For to the originating client IP before forwarding the
    request to the Lambda.  Reading request.client.host would return the Vercel proxy
    IP instead of the real client, causing all rate-limit records to share a single
    IP and making rate-limiting ineffective (RR3-15).

    Falls back to request.client.host when X-Forwarded-For is absent (e.g. local dev).
    """
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@dataclass
class BetterAuthUser:
    """Represents an authenticated admin user validated via Better Auth."""

    email: str
    user_id: str
    is_server_admin: bool = False


async def require_admin(request: Request) -> BetterAuthUser:
    """Validate a Better Auth session by calling the Neon Auth get-session endpoint.

    Better Auth session tokens are opaque HMAC-signed cookies, not JWTs.
    The only way to validate them from a separate backend is to forward the
    cookie to the Better Auth service and receive the session payload back.

    Retries up to _GET_SESSION_MAX_RETRIES times on non-200 responses to handle
    Neon Auth cold starts (the service is serverless and may return transient errors
    during Lambda initialization).

    Raises 401 if:
    - No session_token cookie is present in the request
    - The Neon Auth service returns a non-200 response after all retries
    - The response body has no user object

    Raises 503 if the Neon Auth service is unreachable after all retries.
    """
    # Neon Auth may use different cookie name prefixes depending on the environment
    # (__Secure-neon-auth.session_token on HTTPS, better-auth.session_token on HTTP).
    # Forward all cookies so Neon Auth can pick whichever one it set.
    raw_cookie = request.headers.get("cookie", "")
    has_session = any(
        "session_token" in part.split("=")[0]
        for part in raw_cookie.split(";")
        if "=" in part
    )
    if not has_session:
        raise HTTPException(status_code=401, detail="Authentication required")

    neon_auth_base_url = settings.neon_auth_base_url.strip()

    headers: dict[str, str] = {"cookie": raw_cookie}

    last_error: Exception | None = None
    for attempt in range(_GET_SESSION_MAX_RETRIES + 1):
        if attempt > 0:
            await asyncio.sleep(_GET_SESSION_RETRY_DELAY)
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.get(
                    f"{neon_auth_base_url}/get-session",
                    headers=headers,
                    timeout=5.0,
                )
            except httpx.RequestError as exc:
                last_error = exc
                continue

        if resp.status_code == 200:
            data = resp.json()
            if not data or not data.get("user"):
                raise HTTPException(status_code=401, detail="Authentication required")
            user = data["user"]
            return BetterAuthUser(
                email=user["email"],
                user_id=user["id"],
                is_server_admin=user.get("role") == "admin",
            )
        # Non-200: retry (handles Neon Auth cold starts)

    if last_error is not None:
        raise HTTPException(status_code=503, detail="Auth service unavailable")
    raise HTTPException(status_code=401, detail="Authentication required")


async def require_operator(
    current_user: BetterAuthUser = Depends(require_admin),
) -> BetterAuthUser:
    """Require the authenticated user to also be a server admin (operator).

    Calls require_admin first (raises 401 if not authenticated), then checks
    is_server_admin (raises 403 if not a server admin).

    Use this dependency on endpoints that manage platform-level settings such
    as subscription configuration and building unarchive.
    """
    if not current_user.is_server_admin:
        raise HTTPException(status_code=403, detail="Operator access required")
    return current_user
