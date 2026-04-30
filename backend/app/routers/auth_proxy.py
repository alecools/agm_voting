"""Catch-all proxy that forwards all /api/auth/* requests to the Neon Auth service.

The frontend Better Auth SDK calls endpoints like POST /api/auth/sign-in/email,
POST /api/auth/forget-password, and POST /api/auth/reset-password directly against
the FastAPI backend.  Since FastAPI has no handlers for these routes (it only uses
Neon Auth server-side for session validation in require_admin), this proxy forwards
them transparently to the configured Neon Auth base URL.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.config import settings

router = APIRouter()


@router.api_route(
    "/api/auth/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def proxy_auth(path: str, request: Request) -> Response:
    """Forward /api/auth/{path} to the Neon Auth service.

    Returns 503 when neon_auth_base_url is not configured.
    Forwards request body, headers (excluding host and content-length),
    query parameters, and HTTP method unchanged.
    """
    if not settings.neon_auth_base_url:
        return Response(content="Auth service not configured", status_code=503)

    target_url = f"{settings.neon_auth_base_url}/api/auth/{path}"

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
