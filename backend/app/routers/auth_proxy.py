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

import json

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import settings

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
    """Return the origin of the incoming request for use in redirectTo URLs.

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
    # referer, content-length, etc.) that cause Neon Auth to reject the request
    # with INVALID_HOSTNAME.
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() in _FORWARD_HEADERS
    }

    body = await request.body()

    # For password-reset requests, inject redirectTo so the reset email link
    # points back to the correct deployment's admin login page.
    if path == "request-password-reset":
        origin = _derive_origin(request)
        if origin:
            try:
                payload = json.loads(body)
                payload["redirectTo"] = f"{origin}/admin/login"
                body = json.dumps(payload).encode()
                headers["content-type"] = "application/json"
                headers.pop("content-length", None)  # httpx sets this automatically
            except (json.JSONDecodeError, Exception):
                pass  # forward as-is if body is not valid JSON

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
