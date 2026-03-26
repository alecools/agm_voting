"""
Unit tests for blob_service.upload_to_blob.

Mocks httpx.AsyncClient so no real network calls are made.

Structure:
  # --- Happy path ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.services import blob_service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_success_response(url: str = "https://public.blob.vercel-storage.com/logo-abc.png") -> MagicMock:
    resp = MagicMock()
    resp.is_success = True
    resp.json.return_value = {"url": url}
    return resp


def _mock_error_response(status_code: int = 500) -> MagicMock:
    resp = MagicMock()
    resp.is_success = False
    resp.status_code = status_code
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestUploadToBlob:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_url_on_success(self, monkeypatch):
        expected_url = "https://public.blob.vercel-storage.com/logo-xyz.png"
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "test-token")

        mock_put = AsyncMock(return_value=_mock_success_response(expected_url))
        mock_client = AsyncMock()
        mock_client.put = mock_put
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.blob_service.httpx.AsyncClient", return_value=mock_client):
            result = await blob_service.upload_to_blob("logo.png", b"fake-image-bytes", "image/png")

        assert result == expected_url

    @pytest.mark.asyncio(loop_scope="session")
    async def test_sends_correct_headers(self, monkeypatch):
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "my-secret-token")

        mock_put = AsyncMock(return_value=_mock_success_response())
        mock_client = AsyncMock()
        mock_client.put = mock_put
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.blob_service.httpx.AsyncClient", return_value=mock_client):
            await blob_service.upload_to_blob("logo.png", b"bytes", "image/png")

        call_kwargs = mock_put.call_args.kwargs
        headers = call_kwargs["headers"]
        assert headers["Authorization"] == "Bearer my-secret-token"
        assert headers["x-content-type"] == "image/png"
        assert headers["x-add-random-suffix"] == "1"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_sends_correct_url(self, monkeypatch):
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "tok")

        mock_put = AsyncMock(return_value=_mock_success_response())
        mock_client = AsyncMock()
        mock_client.put = mock_put
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.blob_service.httpx.AsyncClient", return_value=mock_client):
            await blob_service.upload_to_blob("my-logo.webp", b"bytes", "image/webp")

        call_args = mock_put.call_args.args
        assert call_args[0] == "https://blob.vercel-storage.com/my-logo.webp"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_sends_file_bytes_as_content(self, monkeypatch):
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "tok")
        file_bytes = b"\x89PNG\r\nfake-png-data"

        mock_put = AsyncMock(return_value=_mock_success_response())
        mock_client = AsyncMock()
        mock_client.put = mock_put
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.blob_service.httpx.AsyncClient", return_value=mock_client):
            await blob_service.upload_to_blob("logo.png", file_bytes, "image/png")

        call_kwargs = mock_put.call_args.kwargs
        assert call_kwargs["content"] == file_bytes

    # --- State / precondition errors ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_raises_500_when_token_missing(self, monkeypatch):
        monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)

        with pytest.raises(HTTPException) as exc_info:
            await blob_service.upload_to_blob("logo.png", b"bytes", "image/png")

        assert exc_info.value.status_code == 500
        assert "not configured" in exc_info.value.detail

    @pytest.mark.asyncio(loop_scope="session")
    async def test_raises_502_when_blob_api_returns_error(self, monkeypatch):
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "tok")

        mock_put = AsyncMock(return_value=_mock_error_response(500))
        mock_client = AsyncMock()
        mock_client.put = mock_put
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.blob_service.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(HTTPException) as exc_info:
                await blob_service.upload_to_blob("logo.png", b"bytes", "image/png")

        assert exc_info.value.status_code == 502
        assert "upload failed" in exc_info.value.detail

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_works_with_svg_content_type(self, monkeypatch):
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "tok")
        expected_url = "https://public.blob.vercel-storage.com/icon.svg"

        mock_put = AsyncMock(return_value=_mock_success_response(expected_url))
        mock_client = AsyncMock()
        mock_client.put = mock_put
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.services.blob_service.httpx.AsyncClient", return_value=mock_client):
            result = await blob_service.upload_to_blob("icon.svg", b"<svg/>", "image/svg+xml")

        assert result == expected_url

    @pytest.mark.asyncio(loop_scope="session")
    async def test_works_with_empty_token_string_raises_500(self, monkeypatch):
        """An empty string token counts as not configured."""
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "")

        with pytest.raises(HTTPException) as exc_info:
            await blob_service.upload_to_blob("logo.png", b"bytes", "image/png")

        assert exc_info.value.status_code == 500
