"""
Shared FastAPI dependencies for the AGM Voting App.

require_admin: validates a Better Auth session by calling the Neon Auth
              get-session endpoint and returns the authenticated user.
get_client_ip: extracts the real client IP from X-Forwarded-For (Vercel proxy).
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import HTTPException, Request

from app.config import settings


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


async def require_admin(request: Request) -> BetterAuthUser:
    """Validate a Better Auth session by calling the Neon Auth get-session endpoint.

    Better Auth session tokens are opaque HMAC-signed cookies, not JWTs.
    The only way to validate them from a separate backend is to forward the
    cookie to the Better Auth service and receive the session payload back.

    Raises 401 if:
    - No session_token cookie is present in the request
    - The Neon Auth service returns a non-200 response
    - The response body has no user object

    Raises 503 if the Neon Auth service is unreachable.
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

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f"{neon_auth_base_url}/get-session",
                headers=headers,
                timeout=5.0,
            )
        except httpx.RequestError:
            raise HTTPException(status_code=503, detail="Auth service unavailable")

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Authentication required")

    data = resp.json()
    if not data or not data.get("user"):
        raise HTTPException(status_code=401, detail="Authentication required")

    user = data["user"]
    return BetterAuthUser(
        email=user["email"],
        user_id=user["id"],
    )
