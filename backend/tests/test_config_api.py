"""
Tests for the tenant configuration API endpoints.

Covers:
  GET  /api/config           (public)
  GET  /api/admin/config     (admin)
  PUT  /api/admin/config     (admin)

And the config_service unit-level behaviour (seed fallback).

Structure per section:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

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
    primary_colour: str = "#005f73",
    support_email: str = "",
) -> TenantConfig:
    await _clear_config(db)
    config = TenantConfig(
        id=1,
        app_name=app_name,
        logo_url=logo_url,
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
        assert body["primary_colour"] == "#005f73"
        assert body["support_email"] == ""

    @pytest.mark.asyncio(loop_scope="session")
    async def test_returns_custom_values(self, app, db_session):
        await _seed_config(
            db_session,
            app_name="Corp Vote",
            logo_url="https://example.com/logo.png",
            primary_colour="#ff0000",
            support_email="help@corp.com",
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "Corp Vote"
        assert body["logo_url"] == "https://example.com/logo.png"
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
        assert set(body.keys()) == {"app_name", "logo_url", "primary_colour", "support_email"}

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
            "primary_colour": "#1a73e8",
            "support_email": "support@example.com",
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["app_name"] == "New Name"
        assert body["logo_url"] == "https://cdn.example.com/logo.png"
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
            primary_colour="#ffffff",
            support_email="support@example.com",
        )
        config = await config_service.update_config(data, db_session)
        assert config.app_name == "Updated"
        assert config.logo_url == "https://cdn.example.com/logo.png"
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
