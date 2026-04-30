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

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import settings

router = APIRouter()

# Map Better Auth SDK path → actual Neon Auth endpoint path.
PATH_ALIASES: dict[str, str] = {
    "forget-password": "request-password-reset",
}


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

    # Forward all headers except host (would mismatch the target) and
    # content-length (httpx recomputes it from the body).
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length")
    }

    body = await request.body()

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
