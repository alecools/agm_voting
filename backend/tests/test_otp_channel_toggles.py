"""
Tests for OTP verification channel toggle feature.

Covers:
  - TenantConfigUpdate model validator (at-least-one check)
  - TenantConfigOut new fields
  - config_service.update_config persists new fields
  - POST /api/auth/request-otp: enabled_channels in response
  - POST /api/auth/request-otp: disabled-channel enforcement (503)
  - POST /api/auth/request-otp: SMS-only + no phone (400 lockout message)
  - PUT /api/admin/config: persists otp_email_enabled / otp_sms_enabled
  - GET /api/config (public): returns new fields
  - GET /api/admin/config: returns new fields

Structure:
  # --- Happy path ---
  # --- Input validation ---
  # --- Boundary values ---
  # --- State / precondition errors ---
  # --- Edge cases ---
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.building import Building
from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.person import Person
from app.models.tenant_config import TenantConfig
from app.schemas.config import TenantConfigUpdate
from app.services import config_service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _meeting_dt() -> datetime:
    return datetime.now(UTC) - timedelta(hours=1)


def _closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


async def _clear_config(db: AsyncSession) -> None:
    await db.execute(delete(TenantConfig))
    await db.flush()


async def _seed_config(
    db: AsyncSession,
    *,
    otp_email_enabled: bool = True,
    otp_sms_enabled: bool = False,
    app_name: str = "AGM Voting",
    primary_colour: str = "#005f73",
) -> TenantConfig:
    await _clear_config(db)
    cfg = TenantConfig(
        id=1,
        app_name=app_name,
        logo_url="",
        favicon_url=None,
        primary_colour=primary_colour,
        support_email="",
        otp_email_enabled=otp_email_enabled,
        otp_sms_enabled=otp_sms_enabled,
    )
    db.add(cfg)
    await db.flush()
    await db.refresh(cfg)
    return cfg


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(loop_scope="session")
async def client(app):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


@pytest_asyncio.fixture
async def building_and_meeting(db_session: AsyncSession):
    """Building with one open GeneralMeeting and one Person with email (no phone)."""
    b = Building(name=f"Toggle Bldg {uuid.uuid4().hex[:6]}", manager_email="mgr@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = Lot(building_id=b.id, lot_number="T-1", unit_entitlement=100)
    db_session.add(lo)
    await db_session.flush()

    p = Person(email="toggle_voter@test.com", phone_number=None)
    db_session.add(p)
    await db_session.flush()
    await db_session.execute(lot_persons.insert().values(lot_id=lo.id, person_id=p.id))

    agm = GeneralMeeting(
        building_id=b.id,
        title="Toggle Test Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=_meeting_dt(),
        voting_closes_at=_closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "lot": lo, "person": p, "agm": agm}


@pytest_asyncio.fixture
async def building_and_meeting_with_phone(db_session: AsyncSession):
    """Building with one open GeneralMeeting and one Person with a phone number."""
    b = Building(name=f"Phone Bldg {uuid.uuid4().hex[:6]}", manager_email="mgr2@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = Lot(building_id=b.id, lot_number="P-1", unit_entitlement=100)
    db_session.add(lo)
    await db_session.flush()

    p = Person(email="phone_voter@test.com", phone_number="+61400000001")
    db_session.add(p)
    await db_session.flush()
    await db_session.execute(lot_persons.insert().values(lot_id=lo.id, person_id=p.id))

    agm = GeneralMeeting(
        building_id=b.id,
        title="Phone Test Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=_meeting_dt(),
        voting_closes_at=_closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "lot": lo, "person": p, "agm": agm}


# ===========================================================================
# Schema unit tests — TenantConfigUpdate model_validator
# ===========================================================================


class TestTenantConfigUpdateValidator:
    """Unit tests for the at-least-one-channel model validator."""

    # --- Input validation ---

    def test_both_false_raises_validation_error(self):
        import pydantic
        with pytest.raises(pydantic.ValidationError) as exc_info:
            TenantConfigUpdate(
                app_name="Test",
                primary_colour="#005f73",
                otp_email_enabled=False,
                otp_sms_enabled=False,
            )
        assert "At least one verification method must be enabled" in str(exc_info.value)

    # --- Happy path ---

    def test_email_true_sms_false_passes(self):
        data = TenantConfigUpdate(
            app_name="Test",
            primary_colour="#005f73",
            otp_email_enabled=True,
            otp_sms_enabled=False,
        )
        assert data.otp_email_enabled is True
        assert data.otp_sms_enabled is False

    def test_email_false_sms_true_passes(self):
        data = TenantConfigUpdate(
            app_name="Test",
            primary_colour="#005f73",
            otp_email_enabled=False,
            otp_sms_enabled=True,
        )
        assert data.otp_email_enabled is False
        assert data.otp_sms_enabled is True

    def test_both_true_passes(self):
        data = TenantConfigUpdate(
            app_name="Test",
            primary_colour="#005f73",
            otp_email_enabled=True,
            otp_sms_enabled=True,
        )
        assert data.otp_email_enabled is True
        assert data.otp_sms_enabled is True

    # --- Boundary values ---

    def test_defaults_are_email_true_sms_false(self):
        """Default field values preserve backward-compatible email-only channel."""
        data = TenantConfigUpdate(app_name="Test", primary_colour="#005f73")
        assert data.otp_email_enabled is True
        assert data.otp_sms_enabled is False


# ===========================================================================
# config_service.update_config — persists new fields
# ===========================================================================


class TestConfigServiceOtpFields:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_update_config_persists_otp_email_disabled(self, db_session):
        await _seed_config(db_session, otp_email_enabled=True, otp_sms_enabled=True)
        data = TenantConfigUpdate(
            app_name="Test",
            primary_colour="#005f73",
            otp_email_enabled=False,
            otp_sms_enabled=True,
        )
        config = await config_service.update_config(data, db_session)
        assert config.otp_email_enabled is False
        assert config.otp_sms_enabled is True

    @pytest.mark.asyncio(loop_scope="session")
    async def test_update_config_persists_sms_enabled(self, db_session):
        await _seed_config(db_session)
        data = TenantConfigUpdate(
            app_name="Test",
            primary_colour="#005f73",
            otp_email_enabled=True,
            otp_sms_enabled=True,
        )
        config = await config_service.update_config(data, db_session)
        assert config.otp_email_enabled is True
        assert config.otp_sms_enabled is True

    @pytest.mark.asyncio(loop_scope="session")
    async def test_get_config_returns_default_otp_flags(self, db_session):
        """Fresh seed row must have otp_email_enabled=True, otp_sms_enabled=False."""
        await _clear_config(db_session)
        config = await config_service.get_config(db_session)
        assert config.otp_email_enabled is True
        assert config.otp_sms_enabled is False


# ===========================================================================
# GET /api/config (public) — new fields returned
# ===========================================================================


class TestPublicConfigOtpFields:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_public_config_returns_otp_fields(self, app, db_session):
        await _seed_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/config")
        assert resp.status_code == 200
        body = resp.json()
        assert "otp_email_enabled" in body
        assert "otp_sms_enabled" in body
        assert body["otp_email_enabled"] is True
        assert body["otp_sms_enabled"] is False

    @pytest.mark.asyncio(loop_scope="session")
    async def test_public_config_reflects_disabled_email(self, app, db_session):
        await _seed_config(db_session, otp_email_enabled=False, otp_sms_enabled=True)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/config")
        body = resp.json()
        assert body["otp_email_enabled"] is False
        assert body["otp_sms_enabled"] is True


# ===========================================================================
# GET /api/admin/config — new fields returned
# ===========================================================================


class TestAdminConfigOtpFields:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_admin_config_returns_otp_fields(self, app, db_session):
        await _seed_config(db_session)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/admin/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["otp_email_enabled"] is True
        assert body["otp_sms_enabled"] is False


# ===========================================================================
# PUT /api/admin/config — persists new fields
# ===========================================================================


class TestAdminUpdateConfigOtpFields:
    # --- Happy path ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_put_config_persists_otp_flags(self, app, db_session):
        await _seed_config(db_session)
        payload = {
            "app_name": "Test",
            "primary_colour": "#005f73",
            "otp_email_enabled": True,
            "otp_sms_enabled": True,
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["otp_email_enabled"] is True
        assert body["otp_sms_enabled"] is True

    @pytest.mark.asyncio(loop_scope="session")
    async def test_put_config_email_only(self, app, db_session):
        await _seed_config(db_session, otp_email_enabled=True, otp_sms_enabled=True)
        payload = {
            "app_name": "Test",
            "primary_colour": "#005f73",
            "otp_email_enabled": True,
            "otp_sms_enabled": False,
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.put("/api/admin/config", json=payload)
        assert resp.status_code == 200
        assert resp.json()["otp_email_enabled"] is True
        assert resp.json()["otp_sms_enabled"] is False

    # --- Input validation ---

    @pytest.mark.asyncio(loop_scope="session")
    async def test_put_config_rejects_both_false(self, app, db_session):
        await _seed_config(db_session)
        payload = {
            "app_name": "Test",
            "primary_colour": "#005f73",
            "otp_email_enabled": False,
            "otp_sms_enabled": False,
        }
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.put("/api/admin/config", json=payload)
        assert resp.status_code == 422


# ===========================================================================
# POST /api/auth/request-otp — enabled_channels in response
# ===========================================================================


@pytest.mark.asyncio
class TestRequestOtpEnabledChannels:
    # --- Happy path ---

    async def test_response_includes_enabled_channels_email_only(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Default config: enabled_channels = ["email"]."""
        agm = building_and_meeting["agm"]
        await _seed_config(db_session, otp_email_enabled=True, otp_sms_enabled=False)
        # Invalidate cache so next call reads from DB
        config_service._config_cache.config = None

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock):
            resp = await client.post(
                "/api/auth/request-otp",
                json={"email": "toggle_voter@test.com", "general_meeting_id": str(agm.id)},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "enabled_channels" in body
        assert body["enabled_channels"] == ["email"]

    async def test_response_includes_both_channels_when_sms_configured(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting_with_phone: dict
    ):
        """When both email and SMS are enabled and SMS provider is set, both appear in enabled_channels."""
        agm = building_and_meeting_with_phone["agm"]
        await _seed_config(db_session, otp_email_enabled=True, otp_sms_enabled=True)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = True
        mock_sms_cfg.sms_provider = "smtp2go"

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={"email": "phone_voter@test.com", "general_meeting_id": str(agm.id)},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "email" in body["enabled_channels"]
        assert "sms" in body["enabled_channels"]

    async def test_response_sms_not_in_channels_when_provider_not_set(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """otp_sms_enabled=True but no SMS provider configured: SMS not in enabled_channels."""
        agm = building_and_meeting["agm"]
        await _seed_config(db_session, otp_email_enabled=True, otp_sms_enabled=True)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = False
        mock_sms_cfg.sms_provider = None

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={"email": "toggle_voter@test.com", "general_meeting_id": str(agm.id)},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled_channels"] == ["email"]
        assert "sms" not in body["enabled_channels"]


# ===========================================================================
# POST /api/auth/request-otp — disabled-channel enforcement
# ===========================================================================


@pytest.mark.asyncio
class TestRequestOtpChannelEnforcement:
    # --- State / precondition errors ---

    async def test_request_email_channel_when_email_disabled_returns_503(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting_with_phone: dict
    ):
        """Requesting email channel when email is disabled returns 503."""
        agm = building_and_meeting_with_phone["agm"]
        await _seed_config(db_session, otp_email_enabled=False, otp_sms_enabled=True)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = True
        mock_sms_cfg.sms_provider = "smtp2go"

        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={
                    "email": "phone_voter@test.com",
                    "general_meeting_id": str(agm.id),
                    "channel": "email",
                },
            )

        assert resp.status_code == 503
        assert "not available" in resp.json()["detail"].lower()

    async def test_request_sms_channel_when_sms_disabled_returns_503(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting_with_phone: dict
    ):
        """Requesting SMS channel when SMS is disabled returns 503."""
        agm = building_and_meeting_with_phone["agm"]
        await _seed_config(db_session, otp_email_enabled=True, otp_sms_enabled=False)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = False
        mock_sms_cfg.sms_provider = None

        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={
                    "email": "phone_voter@test.com",
                    "general_meeting_id": str(agm.id),
                    "channel": "sms",
                },
            )

        assert resp.status_code == 503
        assert "not available" in resp.json()["detail"].lower()

    # --- Edge cases ---

    async def test_no_channels_configured_falls_back_to_email(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Edge case: both otp_email_enabled=False and otp_sms_enabled=False in DB.
        Backend falls back to ['email'] so email channel requests still work."""
        agm = building_and_meeting["agm"]
        # Force both to False directly on the DB row (bypasses validator)
        await _clear_config(db_session)
        cfg = TenantConfig(
            id=1,
            app_name="Test",
            logo_url="",
            favicon_url=None,
            primary_colour="#005f73",
            support_email="",
            otp_email_enabled=False,
            otp_sms_enabled=False,
        )
        db_session.add(cfg)
        await db_session.flush()
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = False
        mock_sms_cfg.sms_provider = None

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={"email": "toggle_voter@test.com", "general_meeting_id": str(agm.id)},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled_channels"] == ["email"]


# ===========================================================================
# POST /api/auth/request-otp — SMS-only lockout for voter with no phone
# ===========================================================================


@pytest.mark.asyncio
class TestRequestOtpSmsOnlyLockout:
    # --- State / precondition errors ---

    async def test_sms_only_no_phone_known_email_returns_400_with_lockout_message(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """SMS-only tenant + known email + no phone → 400 with lockout message."""
        agm = building_and_meeting["agm"]
        await _seed_config(db_session, otp_email_enabled=False, otp_sms_enabled=True)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = True
        mock_sms_cfg.sms_provider = "smtp2go"

        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={
                    "email": "toggle_voter@test.com",
                    "general_meeting_id": str(agm.id),
                    # channel defaults to "email" but SMS is enabled; voter has no phone
                },
            )

        assert resp.status_code == 400
        assert "SMS is the only verification method" in resp.json()["detail"]
        assert "no phone number" in resp.json()["detail"]

    async def test_sms_only_no_phone_unknown_email_returns_200_not_lockout(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """SMS-only + UNKNOWN email: must not reveal lockout (enumeration protection).
        The 400 lockout is only triggered for known emails."""
        agm = building_and_meeting["agm"]
        await _seed_config(db_session, otp_email_enabled=False, otp_sms_enabled=True)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = True
        mock_sms_cfg.sms_provider = "smtp2go"

        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg):
            resp = await client.post(
                "/api/auth/request-otp",
                json={"email": "unknown@nobody.com", "general_meeting_id": str(agm.id)},
            )

        assert resp.status_code == 200
        assert resp.json()["sent"] is True

    async def test_sms_only_voter_with_phone_succeeds(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting_with_phone: dict
    ):
        """SMS-only tenant + known email + has phone → OTP sent, 200."""
        agm = building_and_meeting_with_phone["agm"]
        await _seed_config(db_session, otp_email_enabled=False, otp_sms_enabled=True)
        config_service._config_cache.config = None

        mock_sms_cfg = MagicMock()
        mock_sms_cfg.sms_enabled = True
        mock_sms_cfg.sms_provider = "smtp2go"
        mock_sms_send = AsyncMock()

        with patch("app.routers.auth.smtp_config_service.get_smtp_config", new_callable=AsyncMock, return_value=mock_sms_cfg), \
             patch("app.routers.auth.smtp_config_service.get_sms_send_kwargs", return_value={}), \
             patch("app.routers.auth.sms_send", mock_sms_send):
            resp = await client.post(
                "/api/auth/request-otp",
                json={
                    "email": "phone_voter@test.com",
                    "general_meeting_id": str(agm.id),
                    "channel": "sms",
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["sent"] is True
        assert body["enabled_channels"] == ["sms"]
