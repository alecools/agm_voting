"""
Tests for the tenant configuration API endpoints.

Covers:
  GET  /api/config           (public)
  GET  /api/admin/config     (admin)
  PUT  /api/admin/config     (admin)

And the config_service unit-level behaviour (seed fallback + cache).

Structure per section:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import time

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from unittest.mock import AsyncMock, MagicMock, patch

from app.models.tenant_config import TenantConfig
from app.services import config_service
from app.schemas.config import TenantConfigUpdate


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _clear_config(db: AsyncSession) -> None:
    """Remove the singleton config row so tests start from a known state."""
    await db.execute(delete(TenantConfig))
    await db.flush()


async def _seed_config(
    db: AsyncSession,
    *,
    app_name: str = "AGM Voting",
    logo_url: str = "",
    favicon_url: str | None = None,
    primary_colour: str = "#005f73",
    support_email: str = "",
) -> TenantConfig:
    await _clear_config(db)
    config = TenantConfig(
        id=1,
        app_name=app_name,
        logo_url=logo_url,
        favicon_url=favicon_url,
        primary_colour=primary_colour,
        support_email=support_email,
    )
    db.add(config)
    await db.flush()
    await db.refresh(config)
    return config


# ===========================================================================
# GET /api/config — public endpoint
# ===========================================================================


class TestPublicGetConfig:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_seed_defaults(self, app, db_session):
        await _seed_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "AGM Voting"
        assert body["logo_url"] == ""
        assert body["favicon_url"] is None
        assert body["primary_colour"] == "#005f73"
        assert body["support_email"] == ""

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_custom_values(self, app, db_session):
        await _seed_config(
            db_session,
            app_name="Corp Vote",
            logo_url="https://example.com/logo.png",
            favicon_url="https://example.com/favicon.png",
            primary_colour="#ff0000",
            support_email="help@corp.com",
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "Corp Vote"
        assert body["logo_url"] == "https://example.com/logo.png"
        assert body["favicon_url"] == "https://example.com/favicon.png"
        assert body["primary_colour"] == "#ff0000"
        assert body["support_email"] == "help@corp.com"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_no_auth_required(self, app, db_session):
        """Public endpoint must be accessible without any admin session cookie."""
        await _seed_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/config")
        assert resp.status_code == 200

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_creates_seed_row_if_missing(self, app, db_session):
        """get_config must create a fallback row when the DB row is absent."""
        await _clear_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "AGM Voting"
        assert body["primary_colour"] == "#005f73"


# ===========================================================================
# GET /api/admin/config — admin-protected endpoint
# ===========================================================================


class TestAdminGetConfig:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_current_config(self, app, db_session):
        await _seed_config(db_session, app_name="My AGM", primary_colour="#123456")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "My AGM"
        assert body["primary_colour"] == "#123456"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_response_shape_has_all_fields(self, app, db_session):
        await _seed_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config")
        body = resp.json()
        assert set(body.keys()) == {"app_name", "logo_url", "favicon_url", "primary_colour", "support_email"}

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_creates_seed_row_if_missing(self, app, db_session):
        await _clear_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "AGM Voting"


# ===========================================================================
# PUT /api/admin/config — admin-protected update endpoint
# ===========================================================================


class TestAdminUpdateConfig:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_updates_all_fields(self, app, db_session):
        await _seed_config(db_session)
        payload = {
            "app_name": "New Name",
            "logo_url": "https://cdn.example.com/logo.png",
            "favicon_url": "https://cdn.example.com/favicon.png",
            "primary_colour": "#1a73e8",
            "support_email": "support@example.com",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "New Name"
        assert body["logo_url"] == "https://cdn.example.com/logo.png"
        assert body["favicon_url"] == "https://cdn.example.com/favicon.png"
        assert body["primary_colour"] == "#1a73e8"
        assert body["support_email"] == "support@example.com"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_optional_fields_default_to_empty_string(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Minimal", "primary_colour": "#ffffff"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["logo_url"] == ""
        assert body["favicon_url"] is None
        assert body["support_email"] == ""

    @pytest.mark.asyncio(loop_scope="session")
    async def test_upsert_creates_row_if_missing(self, app, db_session):
        """PUT must work even if the config row was somehow deleted."""
        await _clear_config(db_session)
        payload = {"app_name": "Fresh Start", "primary_colour": "#abcdef"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "Fresh Start"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_3_char_hex_colour(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Test", "primary_colour": "#abc"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["primary_colour"] == "#abc"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_strips_whitespace_from_optional_fields(self, app, db_session):
        await _seed_config(db_session)
        payload = {
            "app_name": "  Trimmed  ",
            "logo_url": "  https://example.com/logo.png  ",
            "primary_colour": "#111111",
            "support_email": "  help@example.com  ",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        body = resp.json()
        assert body["app_name"] == "Trimmed"
        assert body["logo_url"] == "https://example.com/logo.png"
        assert body["support_email"] == "help@example.com"

    # --- Input validation ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_empty_app_name(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "", "primary_colour": "#005f73"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_whitespace_only_app_name(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "   ", "primary_colour": "#005f73"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_missing_app_name(self, app, db_session):
        await _seed_config(db_session)
        payload = {"primary_colour": "#005f73"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_invalid_hex_colour_no_hash(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Test", "primary_colour": "005f73"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_invalid_hex_colour_word(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Test", "primary_colour": "notacolour"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_missing_primary_colour(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Test"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_hex_colour_wrong_length(self, app, db_session):
        """4-character and 5-character hex strings must be rejected."""
        await _seed_config(db_session)
        for bad_colour in ("#abcd", "#abcde"):
            payload = {"app_name": "Test", "primary_colour": bad_colour}
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.put("/api/admin/config", json=payload)
            assert resp.status_code == 422, f"Expected 422 for colour {bad_colour!r}"

    # --- Boundary values ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_app_name_max_length_200(self, app, db_session):
        """app_name at exactly 200 characters must be accepted."""
        await _seed_config(db_session)
        long_name = "A" * 200
        payload = {"app_name": long_name, "primary_colour": "#005f73"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["app_name"] == long_name

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_uppercase_hex(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Test", "primary_colour": "#AABBCC"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["primary_colour"] == "#AABBCC"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_mixed_case_hex(self, app, db_session):
        await _seed_config(db_session)
        payload = {"app_name": "Test", "primary_colour": "#Ab1Cd2"}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200

    # --- State / precondition errors ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_second_put_overwrites_first(self, app, db_session):
        """Calling PUT twice must always reflect the most recent values."""
        await _seed_config(db_session)
        for name in ["First Name", "Second Name"]:
            payload = {"app_name": name, "primary_colour": "#005f73"}
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.put("/api/admin/config", json=payload)
            assert resp.status_code == 200

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config")
        assert resp.json()["app_name"] == "Second Name"


# ===========================================================================
# config_service unit tests (direct service calls)
# ===========================================================================


class TestConfigService:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_get_config_returns_existing_row(self, db_session):
        await _seed_config(db_session, app_name="Direct Test")
        config = await config_service.get_config(db_session)
        assert config.app_name == "Direct Test"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_update_config_changes_values(self, db_session):
        await _seed_config(db_session)
        data = TenantConfigUpdate(
            app_name="Updated",
            logo_url="https://cdn.example.com/logo.png",
            favicon_url="https://cdn.example.com/favicon.png",
            primary_colour="#ffffff",
            support_email="support@example.com",
        )
        config = await config_service.update_config(data, db_session)
        assert config.app_name == "Updated"
        assert config.logo_url == "https://cdn.example.com/logo.png"
        assert config.favicon_url == "https://cdn.example.com/favicon.png"
        assert config.primary_colour == "#ffffff"
        assert config.support_email == "support@example.com"

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_get_config_seeds_missing_row(self, db_session):
        """get_config must auto-seed if no row exists."""
        await _clear_config(db_session)
        config = await config_service.get_config(db_session)
        assert config.id == 1
        assert config.app_name == "AGM Voting"
        assert config.primary_colour == "#005f73"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_update_config_upserts_missing_row(self, db_session):
        """update_config must create row id=1 if it does not exist."""
        await _clear_config(db_session)
        data = TenantConfigUpdate(app_name="Upserted", primary_colour="#123456")
        config = await config_service.update_config(data, db_session)
        assert config.id == 1
        assert config.app_name == "Upserted"


# ===========================================================================
# POST /api/admin/config/logo — logo upload endpoint
# ===========================================================================


def _make_mock_blob_success(url: str = "https://public.blob.vercel-storage.com/logo-abc.png"):
    return AsyncMock(return_value=url)


class TestAdminUploadLogo:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_url_on_valid_png_upload(self, app):
        blob_url = "https://public.blob.vercel-storage.com/logo-test.png"
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success(blob_url)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", b"\x89PNG\r\nfake", "image/png")},
                )
        assert resp.status_code == 200
        assert resp.json() == {"url": blob_url}

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_jpeg_by_extension(self, app):
        blob_url = "https://public.blob.vercel-storage.com/logo-test.jpg"
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success(blob_url)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("photo.jpg", b"fake-jpeg", "image/jpeg")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_webp_by_extension(self, app):
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.webp", b"fake-webp", "image/webp")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_svg_by_extension(self, app):
        """HIGH-4: SVG uploads are rejected with 422 to prevent stored XSS via embedded scripts."""
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/logo",
                files={"file": ("icon.svg", b"<svg/>", "image/svg+xml")},
            )
        assert resp.status_code == 422
        assert "SVG" in resp.json()["detail"]

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_svg_by_content_type_only(self, app):
        """HIGH-4: SVG content-type without .svg extension is also rejected."""
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/logo",
                files={"file": ("logo", b"<svg/>", "image/svg+xml")},
            )
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_gif_by_extension(self, app):
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("anim.gif", b"GIF89a", "image/gif")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepted_by_content_type_when_no_extension(self, app):
        """When filename has no extension, content-type is used for detection."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo", b"fake-png", "image/png")},
                )
        assert resp.status_code == 200

    # --- Input validation ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_file_over_5mb(self, app):
        big_content = b"x" * (5 * 1024 * 1024 + 1)
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", big_content, "image/png")},
                )
        assert resp.status_code == 400
        assert "5 MB" in resp.json()["detail"]

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_txt_file(self, app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/logo",
                files={"file": ("notes.txt", b"hello", "text/plain")},
            )
        assert resp.status_code == 415

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_pdf_file(self, app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/logo",
                files={"file": ("doc.pdf", b"%PDF", "application/pdf")},
            )
        assert resp.status_code == 415

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_csv_file(self, app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/logo",
                files={"file": ("data.csv", b"a,b,c", "text/csv")},
            )
        assert resp.status_code == 415

    # --- Boundary values ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_file_exactly_at_5mb_limit(self, app):
        exactly_5mb = b"x" * (5 * 1024 * 1024)
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", exactly_5mb, "image/png")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_empty_file(self, app):
        """An empty file is technically valid at the endpoint level (blob service handles it)."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", b"", "image/png")},
                )
        assert resp.status_code == 200

    # --- State / precondition errors ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_propagates_502_from_blob_service(self, app):
        from fastapi import HTTPException as FHE
        async def raise_502(*args, **kwargs):
            raise FHE(status_code=502, detail="Logo upload failed")

        with patch("app.routers.admin.blob_service.upload_to_blob", raise_502):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", b"bytes", "image/png")},
                )
        assert resp.status_code == 502

    @pytest.mark.asyncio(loop_scope="session")
    async def test_propagates_500_from_blob_service_when_token_missing(self, app):
        from fastapi import HTTPException as FHE
        async def raise_500(*args, **kwargs):
            raise FHE(status_code=500, detail="Blob storage not configured")

        with patch("app.routers.admin.blob_service.upload_to_blob", raise_500):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", b"bytes", "image/png")},
                )
        assert resp.status_code == 500

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_jpeg_with_jpg_extension(self, app):
        """Both .jpg and .jpeg extensions must map to image/jpeg."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("photo.jpeg", b"fake-jpeg", "application/octet-stream")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_extension_takes_precedence_over_content_type(self, app):
        """A .png file sent with wrong content-type must still be accepted."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/logo",
                    files={"file": ("logo.png", b"fake-png", "application/octet-stream")},
                )
        assert resp.status_code == 200


# ===========================================================================
# POST /api/admin/config/favicon — favicon upload endpoint
# ===========================================================================


def _make_mock_favicon_blob_success(url: str = "https://public.blob.vercel-storage.com/favicon-abc.png"):
    return AsyncMock(return_value=url)


class TestAdminUploadFavicon:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_url_on_valid_png_upload(self, app):
        blob_url = "https://public.blob.vercel-storage.com/favicon-test.png"
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success(blob_url)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", b"\x89PNG\r\nfake", "image/png")},
                )
        assert resp.status_code == 200
        assert resp.json() == {"url": blob_url}

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_jpeg_by_extension(self, app):
        blob_url = "https://public.blob.vercel-storage.com/favicon-test.jpg"
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success(blob_url)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.jpg", b"fake-jpeg", "image/jpeg")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_webp_by_extension(self, app):
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.webp", b"fake-webp", "image/webp")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_svg_by_extension(self, app):
        """HIGH-4: SVG uploads are rejected with 422 to prevent stored XSS via embedded scripts."""
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/favicon",
                files={"file": ("icon.svg", b"<svg/>", "image/svg+xml")},
            )
        assert resp.status_code == 422
        assert "SVG" in resp.json()["detail"]

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_svg_by_content_type_only(self, app):
        """HIGH-4: SVG content-type without .svg extension is also rejected."""
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/favicon",
                files={"file": ("favicon", b"<svg/>", "image/svg+xml")},
            )
        assert resp.status_code == 422

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_gif_by_extension(self, app):
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("anim.gif", b"GIF89a", "image/gif")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepted_by_content_type_when_no_extension(self, app):
        """When filename has no extension, content-type is used for detection."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon", b"fake-png", "image/png")},
                )
        assert resp.status_code == 200

    # --- Input validation ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_file_over_5mb(self, app):
        big_content = b"x" * (5 * 1024 * 1024 + 1)
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", big_content, "image/png")},
                )
        assert resp.status_code == 400
        assert "5 MB" in resp.json()["detail"]

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_txt_file(self, app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/favicon",
                files={"file": ("notes.txt", b"hello", "text/plain")},
            )
        assert resp.status_code == 415

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_pdf_file(self, app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/favicon",
                files={"file": ("doc.pdf", b"%PDF", "application/pdf")},
            )
        assert resp.status_code == 415

    @pytest.mark.asyncio(loop_scope="session")
    async def test_rejects_csv_file(self, app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/admin/config/favicon",
                files={"file": ("data.csv", b"a,b,c", "text/csv")},
            )
        assert resp.status_code == 415

    # --- Boundary values ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_file_exactly_at_5mb_limit(self, app):
        exactly_5mb = b"x" * (5 * 1024 * 1024)
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", exactly_5mb, "image/png")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_empty_file(self, app):
        """An empty file is technically valid at the endpoint level."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", b"", "image/png")},
                )
        assert resp.status_code == 200

    # --- State / precondition errors ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_propagates_502_from_blob_service(self, app):
        from fastapi import HTTPException as FHE
        async def raise_502(*args, **kwargs):
            raise FHE(status_code=502, detail="Logo upload failed")

        with patch("app.routers.admin.blob_service.upload_to_blob", raise_502):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", b"bytes", "image/png")},
                )
        assert resp.status_code == 502

    @pytest.mark.asyncio(loop_scope="session")
    async def test_propagates_500_from_blob_service_when_token_missing(self, app):
        from fastapi import HTTPException as FHE
        async def raise_500(*args, **kwargs):
            raise FHE(status_code=500, detail="Blob storage not configured")

        with patch("app.routers.admin.blob_service.upload_to_blob", raise_500):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", b"bytes", "image/png")},
                )
        assert resp.status_code == 500

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_accepts_jpeg_with_jpeg_extension(self, app):
        """Both .jpg and .jpeg extensions must map to image/jpeg."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.jpeg", b"fake-jpeg", "application/octet-stream")},
                )
        assert resp.status_code == 200

    @pytest.mark.asyncio(loop_scope="session")
    async def test_extension_takes_precedence_over_content_type(self, app):
        """A .png file sent with wrong content-type must still be accepted."""
        with patch("app.routers.admin.blob_service.upload_to_blob", _make_mock_favicon_blob_success()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post(
                    "/api/admin/config/favicon",
                    files={"file": ("favicon.png", b"fake-png", "application/octet-stream")},
                )
        assert resp.status_code == 200


# ===========================================================================
# favicon_url in config read/write (integration)
# ===========================================================================


class TestFaviconUrlInConfig:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_public_config_includes_favicon_url(self, app, db_session):
        await _seed_config(db_session, favicon_url="https://example.com/fav.png")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/config")
        assert resp.status_code == 200
        assert resp.json()["favicon_url"] == "https://example.com/fav.png"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_admin_config_includes_favicon_url(self, app, db_session):
        await _seed_config(db_session, favicon_url="https://example.com/fav.ico")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/admin/config")
        assert resp.status_code == 200
        assert resp.json()["favicon_url"] == "https://example.com/fav.ico"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_put_config_saves_favicon_url(self, app, db_session):
        await _seed_config(db_session)
        payload = {
            "app_name": "Test",
            "logo_url": "",
            "favicon_url": "https://cdn.example.com/fav.png",
            "primary_colour": "#005f73",
            "support_email": "",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["favicon_url"] == "https://cdn.example.com/fav.png"

    @pytest.mark.asyncio(loop_scope="session")
    async def test_put_config_clears_favicon_url_when_null(self, app, db_session):
        await _seed_config(db_session, favicon_url="https://example.com/fav.png")
        payload = {
            "app_name": "Test",
            "logo_url": "",
            "favicon_url": None,
            "primary_colour": "#005f73",
            "support_email": "",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["favicon_url"] is None

    @pytest.mark.asyncio(loop_scope="session")
    async def test_put_config_clears_favicon_url_when_empty_string(self, app, db_session):
        """Empty string favicon_url should be normalised to null."""
        await _seed_config(db_session, favicon_url="https://example.com/fav.png")
        payload = {
            "app_name": "Test",
            "logo_url": "",
            "favicon_url": "   ",
            "primary_colour": "#005f73",
            "support_email": "",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["favicon_url"] is None

    # --- Schema unit tests ---

    def test_tenant_config_update_strips_favicon_url(self):
        data = TenantConfigUpdate(
            app_name="Test",
            favicon_url="  https://cdn.example.com/fav.png  ",
            primary_colour="#005f73",
        )
        assert data.favicon_url == "https://cdn.example.com/fav.png"

    def test_tenant_config_update_favicon_url_empty_string_becomes_none(self):
        data = TenantConfigUpdate(
            app_name="Test",
            favicon_url="",
            primary_colour="#005f73",
        )
        assert data.favicon_url is None

    def test_tenant_config_update_favicon_url_whitespace_becomes_none(self):
        data = TenantConfigUpdate(
            app_name="Test",
            favicon_url="   ",
            primary_colour="#005f73",
        )
        assert data.favicon_url is None

    def test_tenant_config_update_favicon_url_none_stays_none(self):
        data = TenantConfigUpdate(
            app_name="Test",
            favicon_url=None,
            primary_colour="#005f73",
        )
        assert data.favicon_url is None


# ===========================================================================
# config_service cache unit tests
# ===========================================================================


class TestConfigServiceCache:
    """Unit tests for the module-level 60 s TTL cache in config_service."""

    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_cache_hit_skips_db_query(self, db_session):
        """Second call within TTL must return cached object without hitting DB."""
        await _seed_config(db_session, app_name="Cached")

        # First call — populates cache
        first = await config_service.get_config(db_session)
        assert first.app_name == "Cached"

        # Patch the DB execute so we can detect if it is called again
        with patch.object(db_session, "execute", wraps=db_session.execute) as mock_exec:
            second = await config_service.get_config(db_session)

        assert second is first  # Same object returned from cache
        mock_exec.assert_not_called()

    @pytest.mark.asyncio(loop_scope="session")
    async def test_cache_populated_after_first_miss(self, db_session):
        """After a DB fetch the cache fields must be set."""
        await _seed_config(db_session, app_name="Populate")
        assert config_service._config_cache.config is None

        await config_service.get_config(db_session)

        assert config_service._config_cache.config is not None
        assert config_service._config_cache.cached_at is not None

    @pytest.mark.asyncio(loop_scope="session")
    async def test_update_config_invalidates_cache(self, db_session):
        """update_config must clear the cache so the next read goes to DB."""
        await _seed_config(db_session, app_name="Before Update")

        # Warm the cache
        await config_service.get_config(db_session)
        assert config_service._config_cache.config is not None

        # Update — must clear cache
        data = TenantConfigUpdate(app_name="After Update", primary_colour="#001122")
        await config_service.update_config(data, db_session)

        assert config_service._config_cache.config is None

    # --- Boundary values ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_cache_miss_after_ttl_expires(self, db_session):
        """A cached_at timestamp older than TTL must trigger a fresh DB query."""
        await _seed_config(db_session, app_name="Stale")

        # Warm the cache but backdate the timestamp beyond TTL
        await config_service.get_config(db_session)
        config_service._config_cache.cached_at = (
            time.monotonic() - config_service._CACHE_TTL_SECONDS - 1.0
        )

        with patch.object(db_session, "execute", wraps=db_session.execute) as mock_exec:
            await config_service.get_config(db_session)

        mock_exec.assert_called_once()

    @pytest.mark.asyncio(loop_scope="session")
    async def test_cache_hit_just_before_ttl_boundary(self, db_session):
        """A cached_at timestamp 1 ms before TTL expiry must still be a cache hit."""
        await _seed_config(db_session, app_name="Fresh")

        await config_service.get_config(db_session)
        # Set cached_at so it is just inside the TTL window
        config_service._config_cache.cached_at = (
            time.monotonic() - config_service._CACHE_TTL_SECONDS + 0.5
        )

        with patch.object(db_session, "execute", wraps=db_session.execute) as mock_exec:
            result = await config_service.get_config(db_session)

        mock_exec.assert_not_called()
        assert result.app_name == "Fresh"

    # --- State / precondition errors ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_cache_miss_when_config_is_none_but_cached_at_set(self, db_session):
        """Cache must be treated as cold when config is None, even with a recent timestamp."""
        await _seed_config(db_session, app_name="Null Config")

        # Simulate a state where cached_at is set but config was cleared (e.g. by update)
        config_service._config_cache.config = None
        config_service._config_cache.cached_at = time.monotonic()

        with patch.object(db_session, "execute", wraps=db_session.execute) as mock_exec:
            result = await config_service.get_config(db_session)

        mock_exec.assert_called_once()
        assert result.app_name == "Null Config"

    # --- Edge cases ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_cached_object_is_detached_from_session(self, db_session):
        """Cached config must be detached (expunge called) so it is safe to return
        across different DB sessions without raising DetachedInstanceError."""
        from sqlalchemy import inspect as sa_inspect

        await _seed_config(db_session, app_name="Detach Test")
        config = await config_service.get_config(db_session)

        insp = sa_inspect(config)
        assert insp.detached or not insp.persistent, (
            "Cached TenantConfig must be detached from the session"
        )

    @pytest.mark.asyncio(loop_scope="session")
    async def test_seed_fallback_result_is_also_cached(self, db_session):
        """When get_config creates the fallback seed row it must also populate the cache."""
        # Ensure no row exists
        await db_session.execute(delete(TenantConfig))
        await db_session.flush()

        assert config_service._config_cache.config is None

        config = await config_service.get_config(db_session)

        assert config_service._config_cache.config is not None
        assert config_service._config_cache.cached_at is not None
        assert config.app_name == "AGM Voting"
