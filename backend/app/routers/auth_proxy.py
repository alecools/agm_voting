"""Catch-all proxy that forwards all /api/auth/* requests to the Neon Auth service.

The frontend Better Auth SDK calls endpoints like POST /api/auth/sign-in/email,
POST /api/auth/forget-password, and POST /api/auth/reset-password directly against
the FastAPI backend.  Since FastAPI has no handlers for these routes (it only uses
Neon Auth server-side for session validation in require_admin), this proxy forwards
them transparently to the configured Neon Auth base URL.

PATH_ALIASES maps the Better Auth SDK path names to the actual Neon Auth endpoint
paths where they differ.  For example, the SDK sends ``forget-password`` but Neon
Auth's actual endpoint is ``request-password-reset``.
"""
from __future__ import annotations

import asyncio
import json

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import settings

# Neon Auth is serverless; cold starts can cause transient non-200s on get-session.
# Retry this path to avoid redirecting the user to the login page mid-session.
_GET_SESSION_PATH = "get-session"
_PROXY_GET_SESSION_MAX_RETRIES = 3
_PROXY_GET_SESSION_RETRY_DELAY = 1.0  # seconds

router = APIRouter()

# Map Better Auth SDK path → actual Neon Auth endpoint path.
PATH_ALIASES: dict[str, str] = {
    "forget-password": "request-password-reset",
}

# Only forward headers that are meaningful to the auth service.
# Using an allowlist avoids accidentally forwarding Vercel-injected headers
# (x-forwarded-host, x-forwarded-for, x-vercel-*, etc.) that cause
# Neon Auth to reject the request with INVALID_HOSTNAME.
_FORWARD_HEADERS = frozenset({
    "content-type",
    "accept",
    "accept-language",
    "accept-encoding",
    "cookie",
    "authorization",
    "user-agent",
    "cache-control",
})


def _derive_origin(request: Request) -> str:
    """Return the browser-facing origin of the incoming request.

    On Vercel, x-forwarded-proto and x-forwarded-host carry the browser-facing
    scheme and hostname.  Falls back to settings.allowed_origin for local dev
    where those headers are absent.
    """
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    if proto and host:
        return f"{proto}://{host}"
    return settings.allowed_origin.strip()


@router.api_route(
    "/api/auth/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def proxy_auth(path: str, request: Request) -> Response:
    """Forward /api/auth/{path} to the Neon Auth service.

    Returns 503 when neon_auth_base_url is not configured.
    Forwards request body, headers (excluding host and content-length),
    query parameters, and HTTP method unchanged.

    Applies PATH_ALIASES so the Better Auth SDK path names that differ from
    Neon Auth's actual endpoint names are translated before forwarding.
    """
    if not settings.neon_auth_base_url:
        return Response(content="Auth service not configured", status_code=503)

    path = PATH_ALIASES.get(path, path)
    target_url = f"{settings.neon_auth_base_url}/{path}"

    # Only forward headers in the allowlist — this blocks Vercel-injected headers
    # (x-forwarded-host, x-forwarded-for, x-real-ip, x-vercel-*, host, origin,
    # referer, content-length, etc.) that would otherwise reach Neon Auth verbatim.
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() in _FORWARD_HEADERS
    }

    # Inject the browser-facing origin so Neon Auth can validate it against
    # trusted_origins. The browser sends the Vercel deployment URL as Origin but
    # Vercel strips/rewrites it before reaching the Lambda — deriving it from
    # x-forwarded-proto/x-forwarded-host gives the real value.
    origin = _derive_origin(request)
    if origin:
        headers["origin"] = origin

    body = await request.body()

    # For password-reset requests, inject redirectTo so the reset email link
    # points back to the correct deployment's admin login page.
    if path == "request-password-reset":
        if origin:
            try:
                payload = json.loads(body)
                payload["redirectTo"] = f"{origin}/admin/login"
                body = json.dumps(payload).encode()
                headers["content-type"] = "application/json"
                headers.pop("content-length", None)  # httpx sets this automatically
            except (json.JSONDecodeError, Exception):
                pass  # forward as-is if body is not valid JSON

    max_retries = _PROXY_GET_SESSION_MAX_RETRIES if path == _GET_SESSION_PATH else 0
    resp = None
    for attempt in range(max_retries + 1):
        if attempt > 0:
            await asyncio.sleep(_PROXY_GET_SESSION_RETRY_DELAY)
        async with httpx.AsyncClient() as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                params=dict(request.query_params),
                follow_redirects=False,
                timeout=30,
            )
        if path != _GET_SESSION_PATH or resp.status_code == 200:
            break

    assert resp is not None  # loop always executes at least once

    # Forward response headers except transfer-encoding (incompatible with
    # buffered Response — httpx already decoded any chunked transfer encoding).
    resp_headers = {
        k: v
        for k, v in resp.headers.items()
        if k.lower() not in ("transfer-encoding",)
    }

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
    )
