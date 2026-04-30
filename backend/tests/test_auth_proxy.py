"""Tests for app.routers.auth_proxy — the /api/auth/* catch-all proxy.

Tests call proxy_auth() directly rather than going through ASGI transport
to ensure accurate coverage measurement of async-with and return statements.
Integration tests using ASGI transport verify the route is correctly
registered and CSRF-exempt.

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.routers.auth_proxy import proxy_auth


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_request(
    method: str = "GET",
    headers: list[tuple[str, str]] | None = None,
    body: bytes = b"",
    query_params: dict | None = None,
) -> MagicMock:
    """Build a minimal mock Starlette Request for direct function calls."""
    mock_request = MagicMock()
    mock_request.method = method
    mock_request.headers.items.return_value = headers or []
    mock_request.body = AsyncMock(return_value=body)
    mock_request.query_params = query_params or {}
    return mock_request


def _make_upstream_response(
    content: bytes = b"{}",
    status_code: int = 200,
    headers: dict | None = None,
) -> MagicMock:
    """Build a mock httpx response."""
    mock_resp = MagicMock()
    mock_resp.content = content
    mock_resp.status_code = status_code
    mock_resp.headers = headers or {}
    return mock_resp


def _make_httpx_client(upstream_response: MagicMock) -> AsyncMock:
    """Build a mock httpx.AsyncClient that returns the given upstream response."""
    mock_client = AsyncMock()
    mock_client.request = AsyncMock(return_value=upstream_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestAuthProxyHappyPath:
    async def test_proxy_returns_upstream_status_and_content(self):
        """proxy_auth forwards the upstream status code and response body."""
        upstream = _make_upstream_response(
            content=b'{"token": "abc123"}',
            status_code=200,
            headers={"content-type": "application/json"},
        )
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="POST", body=b'{"email":"a@b.com"}')

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            response = await proxy_auth(path="sign-in/email", request=request)

        assert response.status_code == 200
        assert response.body == b'{"token": "abc123"}'

    async def test_proxy_constructs_target_url_correctly(self):
        """proxy_auth builds target_url as {neon_auth_base_url}/api/auth/{path}."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="POST")

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="forget-password", request=request)

        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["url"] == "https://auth.example.com/api/auth/forget-password"

    async def test_proxy_forwards_http_method(self):
        """proxy_auth forwards the request method unchanged."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="DELETE")

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="session/revoke", request=request)

        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["method"] == "DELETE"

    async def test_proxy_forwards_body_unchanged(self):
        """proxy_auth passes the request body to httpx unchanged."""
        payload = b'{"email":"admin@example.com","password":"secret"}'
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="POST", body=payload)

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="sign-in/email", request=request)

        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["content"] == payload

    async def test_proxy_forwards_query_params(self):
        """proxy_auth forwards query parameters to the upstream service."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(
            method="GET",
            query_params={"code": "xyz", "state": "abc"},
        )

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="callback", request=request)

        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["params"]["code"] == "xyz"
        assert call_kwargs["params"]["state"] == "abc"

    async def test_proxy_strips_host_and_content_length_from_headers(self):
        """proxy_auth strips 'host' and 'content-length' before forwarding headers."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(
            method="POST",
            headers=[
                ("host", "localhost:8000"),
                ("content-length", "42"),
                ("content-type", "application/json"),
                ("x-custom-header", "value"),
            ],
        )

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="sign-in/email", request=request)

        forwarded = mock_client.request.call_args.kwargs["headers"]
        assert "host" not in {k.lower() for k in forwarded}
        assert "content-length" not in {k.lower() for k in forwarded}
        # Other headers are preserved
        assert forwarded.get("content-type") == "application/json"
        assert forwarded.get("x-custom-header") == "value"

    async def test_proxy_strips_transfer_encoding_from_response_headers(self):
        """proxy_auth strips transfer-encoding from the upstream response headers."""
        upstream = _make_upstream_response(
            content=b'{"ok": true}',
            headers={
                "content-type": "application/json",
                "transfer-encoding": "chunked",
                "x-custom": "keep-me",
            },
        )
        mock_client = _make_httpx_client(upstream)
        request = _make_request()

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            response = await proxy_auth(path="get-session", request=request)

        assert "transfer-encoding" not in {k.lower() for k in response.headers}
        # Other response headers are preserved
        assert response.headers.get("x-custom") == "keep-me"

    async def test_proxy_forwards_upstream_non_200_status(self):
        """proxy_auth transparently forwards non-200 upstream status codes."""
        upstream = _make_upstream_response(
            content=b'{"detail": "invalid credentials"}',
            status_code=401,
        )
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="POST")

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            response = await proxy_auth(path="sign-in/email", request=request)

        assert response.status_code == 401

    async def test_proxy_does_not_follow_redirects(self):
        """proxy_auth passes follow_redirects=False so redirects are forwarded as-is."""
        upstream = _make_upstream_response(status_code=302, headers={"location": "/dashboard"})
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="GET")

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            response = await proxy_auth(path="callback", request=request)

        assert response.status_code == 302
        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["follow_redirects"] is False

    async def test_proxy_uses_30_second_timeout(self):
        """proxy_auth passes timeout=30 to the upstream httpx request."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request()

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="get-session", request=request)

        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["timeout"] == 30


# ---------------------------------------------------------------------------
# State / precondition errors
# ---------------------------------------------------------------------------


class TestAuthProxyUnconfigured:
    async def test_returns_503_when_neon_auth_base_url_is_empty(self):
        """proxy_auth returns 503 when neon_auth_base_url is empty."""
        request = _make_request()

        with patch("app.routers.auth_proxy.settings") as ms:
            ms.neon_auth_base_url = ""
            response = await proxy_auth(path="sign-in/email", request=request)

        assert response.status_code == 503
        assert b"not configured" in response.body

    async def test_returns_503_for_get_when_unconfigured(self):
        """503 is also returned for GET requests when neon_auth_base_url is empty."""
        request = _make_request(method="GET")

        with patch("app.routers.auth_proxy.settings") as ms:
            ms.neon_auth_base_url = ""
            response = await proxy_auth(path="get-session", request=request)

        assert response.status_code == 503


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestAuthProxyEdgeCases:
    async def test_proxy_handles_nested_path(self):
        """proxy_auth correctly maps nested paths like sign-in/email."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(method="POST")

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="sign-in/email", request=request)

        call_url = mock_client.request.call_args.kwargs["url"]
        assert call_url == "https://auth.example.com/api/auth/sign-in/email"

    async def test_proxy_handles_empty_query_params(self):
        """proxy_auth passes an empty dict for params when no query string is present."""
        upstream = _make_upstream_response()
        mock_client = _make_httpx_client(upstream)
        request = _make_request(query_params={})

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            await proxy_auth(path="get-session", request=request)

        call_kwargs = mock_client.request.call_args.kwargs
        assert call_kwargs["params"] == {}

    async def test_proxy_handles_empty_upstream_response_headers(self):
        """proxy_auth handles upstream responses with no headers gracefully."""
        upstream = _make_upstream_response(headers={})
        mock_client = _make_httpx_client(upstream)
        request = _make_request()

        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"
            response = await proxy_auth(path="get-session", request=request)

        assert response.status_code == 200


# ---------------------------------------------------------------------------
# Integration: route registration and CSRF exemption
# ---------------------------------------------------------------------------


class TestAuthProxyIntegration:
    """Verify the proxy route is correctly registered in the app and is CSRF-exempt."""

    async def test_proxy_route_is_registered_and_reachable(self):
        """GET /api/auth/get-session reaches proxy_auth when neon_auth_base_url is set."""
        upstream = _make_upstream_response(content=b'{"user": null}', status_code=200)
        mock_client = _make_httpx_client(upstream)

        app = create_app()
        with patch("app.routers.auth_proxy.settings") as ms, \
             patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
            ms.neon_auth_base_url = "https://auth.example.com"

            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/api/auth/get-session")

        assert response.status_code == 200

    async def test_proxy_sign_in_reachable_without_csrf_header(self):
        """POST /api/auth/sign-in/email is CSRF-exempt — reaches the proxy without X-Requested-With."""
        import app.main as main_module
        from app.config import Settings

        upstream = _make_upstream_response(content=b'{"token": "t"}', status_code=200)
        mock_client = _make_httpx_client(upstream)

        # Run with testing_mode=False to activate CSRF enforcement
        prod_settings = Settings(testing_mode=False)
        csrf_app = create_app()
        original_settings = main_module.settings
        main_module.settings = prod_settings
        try:
            with patch("app.routers.auth_proxy.settings") as ms, \
                 patch("app.routers.auth_proxy.httpx.AsyncClient", return_value=mock_client):
                ms.neon_auth_base_url = "https://auth.example.com"

                async with AsyncClient(
                    transport=ASGITransport(app=csrf_app), base_url="http://test"
                    # Intentionally no X-Requested-With header
                ) as client:
                    response = await client.post(
                        "/api/auth/sign-in/email",
                        json={"email": "a@b.com", "password": "p"},
                    )

            # Must NOT be 403 (CSRF) — the /api/auth/* prefix is exempt
            assert response.status_code != 403
        finally:
            main_module.settings = original_settings

    async def test_proxy_returns_503_via_asgi_when_unconfigured(self):
        """GET /api/auth/get-session returns 503 via ASGI when neon_auth_base_url is empty."""
        app = create_app()
        with patch("app.routers.auth_proxy.settings") as ms:
            ms.neon_auth_base_url = ""

            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/api/auth/get-session")

        assert response.status_code == 503
