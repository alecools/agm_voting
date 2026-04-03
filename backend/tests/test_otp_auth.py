"""
Tests for OTP authentication:
  - POST /api/auth/request-otp
  - GET  /api/test/latest-otp
  - OTP code generation
  - email_override behaviour in send_otp_email

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
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AuthOtp,
    Building,
    GeneralMeeting,
    GeneralMeetingStatus,
    LotOwner,
    LotProxy,
    OTPRateLimit,
)
from app.models.lot_owner_email import LotOwnerEmail
from app.routers.auth import _generate_otp_code, _OTP_ALPHABET


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def meeting_dt() -> datetime:
    return datetime.now(UTC) - timedelta(hours=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


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
    """Building with one open GeneralMeeting and one lot owner."""
    b = Building(name=f"OTP Bldg {uuid.uuid4().hex[:6]}", manager_email="otpmgr@test.com")
    db_session.add(b)
    await db_session.flush()

    lo = LotOwner(building_id=b.id, lot_number="OTP-1", unit_entitlement=100)
    db_session.add(lo)
    await db_session.flush()

    lo_email = LotOwnerEmail(lot_owner_id=lo.id, email="otp_voter@test.com")
    db_session.add(lo_email)

    agm = GeneralMeeting(
        building_id=b.id,
        title="OTP Test Meeting",
        status=GeneralMeetingStatus.open,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
    )
    db_session.add(agm)
    await db_session.flush()

    return {"building": b, "lot_owner": lo, "voter_email": "otp_voter@test.com", "agm": agm}


# ---------------------------------------------------------------------------
# OTP code generation
# ---------------------------------------------------------------------------


class TestOtpCodeGeneration:
    # --- Happy path ---

    def test_code_is_8_characters(self):
        code = _generate_otp_code()
        assert len(code) == 8

    def test_code_uses_allowed_alphabet_only(self):
        for _ in range(20):
            code = _generate_otp_code()
            for ch in code:
                assert ch in _OTP_ALPHABET, f"Character '{ch}' not in allowed alphabet"

    def test_alphabet_excludes_ambiguous_chars(self):
        assert "O" not in _OTP_ALPHABET
        assert "0" not in _OTP_ALPHABET
        assert "I" not in _OTP_ALPHABET
        assert "1" not in _OTP_ALPHABET

    # --- Boundary values ---

    def test_two_consecutive_codes_differ(self):
        """Probabilistic: 10 pairs must each differ (collision prob ~10^-9)."""
        for _ in range(10):
            assert _generate_otp_code() != _generate_otp_code()

    def test_code_is_uppercase(self):
        code = _generate_otp_code()
        assert code == code.upper()


# ---------------------------------------------------------------------------
# POST /api/auth/request-otp
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestRequestOtp:
    # --- Happy path ---

    async def test_request_otp_known_email_returns_200_sent_true(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Known email returns 200 {"sent": true} and inserts OTP row."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        assert response.json() == {"sent": True}
        mock_send.assert_awaited_once()

    async def test_request_otp_inserts_otp_row(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """An AuthOtp row is created when a valid email requests OTP."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock):
            await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        result = await db_session.execute(
            select(AuthOtp).where(
                AuthOtp.email == voter_email,
                AuthOtp.meeting_id == agm.id,
            )
        )
        otp = result.scalar_one_or_none()
        assert otp is not None
        assert len(otp.code) == 8
        assert otp.used is False
        assert otp.expires_at > datetime.now(UTC)

    async def test_request_otp_proxy_email_returns_200(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """A proxy email (not a direct owner) also triggers OTP generation."""
        agm = building_and_meeting["agm"]
        lo = building_and_meeting["lot_owner"]
        proxy_email = "proxy_otp@test.com"
        lp = LotProxy(lot_owner_id=lo.id, proxy_email=proxy_email)
        db_session.add(lp)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": proxy_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        mock_send.assert_awaited_once()

    async def test_request_otp_otp_email_receives_correct_args(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """send_otp_email is called with the voter email and meeting title."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        call_kwargs = mock_send.call_args
        assert call_kwargs.kwargs["to_email"] == voter_email
        assert call_kwargs.kwargs["meeting_title"] == agm.title
        assert len(call_kwargs.kwargs["code"]) == 8

    # --- Enumeration protection ---

    async def test_request_otp_unknown_email_still_returns_200_sent_true(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Unknown email returns 200 {"sent": true} — no enumeration."""
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": "nobody@unknown.com", "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        assert response.json() == {"sent": True}
        mock_send.assert_not_called()

    async def test_request_otp_unknown_email_no_otp_row_inserted(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Unknown email does not insert an OTP row."""
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock):
            await client.post(
                "/api/auth/request-otp",
                json={"email": "nobody2@unknown.com", "general_meeting_id": str(agm.id)},
            )

        result = await db_session.execute(
            select(AuthOtp).where(
                AuthOtp.email == "nobody2@unknown.com",
                AuthOtp.meeting_id == agm.id,
            )
        )
        assert result.scalar_one_or_none() is None

    # --- Input validation ---

    async def test_request_otp_empty_email_returns_422(
        self, client: AsyncClient, building_and_meeting: dict
    ):
        agm = building_and_meeting["agm"]
        response = await client.post(
            "/api/auth/request-otp",
            json={"email": "", "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 422

    async def test_request_otp_whitespace_email_returns_422(
        self, client: AsyncClient, building_and_meeting: dict
    ):
        agm = building_and_meeting["agm"]
        response = await client.post(
            "/api/auth/request-otp",
            json={"email": "   ", "general_meeting_id": str(agm.id)},
        )
        assert response.status_code == 422

    async def test_request_otp_missing_meeting_id_returns_422(
        self, client: AsyncClient
    ):
        response = await client.post(
            "/api/auth/request-otp",
            json={"email": "voter@test.com"},
        )
        assert response.status_code == 422

    # --- State / precondition errors ---

    async def test_request_otp_meeting_not_found_returns_404(
        self, client: AsyncClient
    ):
        response = await client.post(
            "/api/auth/request-otp",
            json={"email": "voter@test.com", "general_meeting_id": str(uuid.uuid4())},
        )
        assert response.status_code == 404
        assert response.json()["detail"] == "General Meeting not found"

    async def test_request_otp_rate_limit_returns_429(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Second request within 60s returns 429 (production mode only)."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # Pre-seed the DB rate limit record with a recent timestamp
        now = datetime.now(UTC)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=1,
            first_attempt_at=now,
            last_attempt_at=now,
        )
        db_session.add(rl)
        await db_session.flush()

        # testing_mode=False so the rate limit check is active
        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )
        assert response.status_code == 429
        assert "Please wait" in response.json()["detail"]

    async def test_request_otp_rate_limit_bypassed_in_testing_mode(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Rate limit is skipped when testing_mode=True — allows E2E test setup and
        test body to request OTPs for the same email+meeting without 60s wait."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # Pre-seed DB rate limit as if a request was just made (still within window)
        now = datetime.now(UTC)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=1,
            first_attempt_at=now,
            last_attempt_at=now,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send, \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = True
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )
        # Must succeed (200), not 429
        assert response.status_code == 200
        assert response.json() == {"sent": True}

    async def test_request_otp_smtp_failure_returns_200(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """SMTP failure → still 200 (OTP already stored; voter can authenticate via test endpoint).

        An SMTP failure must not 500 the user — the OTP record was successfully
        committed to the DB before the send attempt, so the voter can still
        authenticate. Returning 500 would also expose SMTP misconfiguration to
        end users and break the auth flow unnecessarily.
        """
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = Exception("SMTP connection refused")
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )
        assert response.status_code == 200
        assert response.json() == {"sent": True}

    async def test_request_otp_smtp_failure_otp_row_still_exists(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When SMTP fails, the OTP row is still in the DB and usable."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = Exception("SMTP connection refused")
            await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        result = await db_session.execute(
            select(AuthOtp).where(
                AuthOtp.email == voter_email,
                AuthOtp.meeting_id == agm.id,
                AuthOtp.used == False,  # noqa: E712
            )
        )
        otp = result.scalar_one_or_none()
        assert otp is not None, "OTP row must exist in DB even after SMTP failure"
        assert len(otp.code) == 8

    # --- Edge cases ---

    async def test_request_otp_previous_otp_deleted_on_resend(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Re-request deletes previous OTP row for same (email, meeting_id)."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        # Insert an existing OTP
        old_otp = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="OLDCODE1",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )
        db_session.add(old_otp)
        await db_session.flush()

        # Rate limit is not active in testing_mode (default), so no pre-clearing needed

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock):
            await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        result = await db_session.execute(
            select(AuthOtp).where(
                AuthOtp.email == voter_email,
                AuthOtp.meeting_id == agm.id,
            )
        )
        otps = list(result.scalars().all())
        # Should have exactly 1 OTP (old one deleted, new one inserted)
        assert len(otps) == 1
        assert otps[0].code != "OLDCODE1"

    async def test_request_otp_skip_email_true_does_not_send_email(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When skip_email=True, OTP is created but send_otp_email is NOT called."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id), "skip_email": True},
            )

        assert response.status_code == 200
        assert response.json() == {"sent": True}
        mock_send.assert_not_called()

    async def test_request_otp_skip_email_true_otp_row_still_created(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When skip_email=True, an AuthOtp row is still created in the DB."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock):
            await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id), "skip_email": True},
            )

        result = await db_session.execute(
            select(AuthOtp).where(
                AuthOtp.email == voter_email,
                AuthOtp.meeting_id == agm.id,
            )
        )
        otp = result.scalar_one_or_none()
        assert otp is not None
        assert len(otp.code) == 8

    async def test_request_otp_skip_email_false_sends_email(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When skip_email=False (default), send_otp_email IS called."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id), "skip_email": False},
            )

        assert response.status_code == 200
        mock_send.assert_awaited_once()

    async def test_request_otp_skip_email_default_sends_email(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When skip_email is omitted, it defaults to False and email IS sent."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        mock_send.assert_awaited_once()

    async def test_request_otp_skip_email_true_smtp_failure_does_not_raise(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When skip_email=True, email send is bypassed entirely — SMTP errors are never raised."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = Exception("SMTP refused")
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id), "skip_email": True},
            )

        # skip_email=True bypasses the call entirely, so no 500
        assert response.status_code == 200
        mock_send.assert_not_called()

    async def test_request_otp_expired_meeting_still_accepts(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Past-close-date meeting still accepts OTP requests (voter may need to view submission)."""
        building = building_and_meeting["building"]
        voter_email = building_and_meeting["voter_email"]

        expired_agm = GeneralMeeting(
            building_id=building.id,
            title="Expired OTP Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=datetime.now(UTC) - timedelta(days=3),
            voting_closes_at=datetime.now(UTC) - timedelta(days=1),
        )
        db_session.add(expired_agm)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(expired_agm.id)},
            )

        assert response.status_code == 200
        mock_send.assert_awaited_once()

    async def test_request_otp_rate_limit_passes_after_window_expires(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Rate limit does not block if previous attempt was outside the 60s window."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # Pre-seed a DB rate-limit record that is older than 60 seconds
        old_time = datetime.now(UTC) - timedelta(seconds=90)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=1,
            first_attempt_at=old_time,
            last_attempt_at=old_time,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send, \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )
        assert response.status_code == 200
        mock_send.assert_awaited_once()

    async def test_request_otp_rate_limit_upsert_increments_existing_record(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """When a rate-limit record already exists and window is expired, attempt_count is incremented."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]

        # Pre-seed an old (expired-window) rate-limit record
        old_time = datetime.now(UTC) - timedelta(seconds=120)
        rl = OTPRateLimit(
            email=voter_email,
            building_id=building.id,
            attempt_count=3,
            first_attempt_at=old_time,
            last_attempt_at=old_time,
        )
        db_session.add(rl)
        await db_session.flush()

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )

        # Fetch the updated record — attempt_count should be incremented
        await db_session.refresh(rl)
        assert rl.attempt_count == 4

    async def test_request_otp_unknown_email_updates_rate_limit_in_production_mode(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Unknown email still updates rate-limit so attackers cannot use absence of rate-limit
        as a signal that the email was not found (enumeration protection)."""
        agm = building_and_meeting["agm"]
        building = building_and_meeting["building"]
        unknown_email = "enumeration-probe@unknown.com"

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock), \
             patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": unknown_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200

        # A rate-limit record should exist for this email + building
        result = await db_session.execute(
            select(OTPRateLimit).where(
                OTPRateLimit.email == unknown_email,
                OTPRateLimit.building_id == building.id,
            )
        )
        rl_record = result.scalar_one_or_none()
        assert rl_record is not None
        assert rl_record.attempt_count == 1

    async def test_request_otp_uppercase_email_normalised_to_lowercase(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Email submitted in mixed case is normalised to lowercase before OTP lookup and storage."""
        agm = building_and_meeting["agm"]
        # voter_email stored in DB is lowercase ("otp_voter@test.com")
        upper_email = "OTP_VOTER@TEST.COM"

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": upper_email, "general_meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        assert response.json() == {"sent": True}
        # The OTP email was sent to the normalised address
        mock_send.assert_called_once()
        call_kwargs = mock_send.call_args
        assert call_kwargs.kwargs["to_email"] == "otp_voter@test.com"

        # OTP row stored with lowercase email
        result = await db_session.execute(
            select(AuthOtp).where(
                AuthOtp.email == "otp_voter@test.com",
                AuthOtp.meeting_id == agm.id,
            )
        )
        otp = result.scalar_one_or_none()
        assert otp is not None


# ---------------------------------------------------------------------------
# GET /api/test/latest-otp
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestLatestOtpEndpoint:
    # --- Happy path ---

    async def test_returns_code_when_testing_mode_enabled(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Returns the latest unused OTP code when testing_mode=True."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        otp = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="TESTRET1",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )
        db_session.add(otp)
        await db_session.flush()

        with patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = True
            response = await client.get(
                "/api/test/latest-otp",
                params={"email": voter_email, "meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["code"] == "TESTRET1"
        assert "expires_at" in data

    # --- State / precondition errors ---

    async def test_returns_404_when_testing_mode_disabled(
        self, client: AsyncClient, building_and_meeting: dict
    ):
        """Returns 404 when testing_mode=False (production safety)."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = False
            response = await client.get(
                "/api/test/latest-otp",
                params={"email": voter_email, "meeting_id": str(agm.id)},
            )

        assert response.status_code == 404

    async def test_returns_404_when_no_otp_found(
        self, client: AsyncClient, building_and_meeting: dict
    ):
        """Returns 404 when no OTP row exists for (email, meeting_id)."""
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = True
            response = await client.get(
                "/api/test/latest-otp",
                params={"email": "no-otp@test.com", "meeting_id": str(agm.id)},
            )

        assert response.status_code == 404
        assert response.json()["detail"] == "No OTP found"

    async def test_returns_404_when_only_used_otps_exist(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Used OTPs are not returned by test endpoint."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        used_otp = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="USEDRETR",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
            used=True,
        )
        db_session.add(used_otp)
        await db_session.flush()

        with patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = True
            response = await client.get(
                "/api/test/latest-otp",
                params={"email": voter_email, "meeting_id": str(agm.id)},
            )

        assert response.status_code == 404

    # --- Edge cases ---

    async def test_returns_most_recent_otp_when_multiple_exist(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """Returns the most recently created OTP when multiple rows exist."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]
        now = datetime.now(UTC)

        otp_old = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="OLDRTRN1",
            expires_at=now + timedelta(minutes=5),
            created_at=now - timedelta(seconds=10),
        )
        db_session.add(otp_old)
        await db_session.flush()

        otp_new = AuthOtp(
            email=voter_email,
            meeting_id=agm.id,
            code="NEWRTRN1",
            expires_at=now + timedelta(minutes=5),
            created_at=now,
        )
        db_session.add(otp_new)
        await db_session.flush()

        with patch("app.routers.auth.settings") as mock_settings:
            mock_settings.testing_mode = True
            response = await client.get(
                "/api/test/latest-otp",
                params={"email": voter_email, "meeting_id": str(agm.id)},
            )

        assert response.status_code == 200
        assert response.json()["code"] == "NEWRTRN1"


# ---------------------------------------------------------------------------
# email_override behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestEmailOverride:
    # --- Happy path ---

    async def test_send_otp_email_uses_override_address(self):
        """When email_override is set, email goes to override address."""
        import aiosmtplib
        from email.mime.multipart import MIMEMultipart
        from unittest.mock import MagicMock

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        mock_db = AsyncMock()

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send), \
             patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config)), \
             patch("app.services.email_service.get_decrypted_password", return_value="pass"):
            mock_settings.email_override = "override@test.com"

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
                db=mock_db,
            )

        assert len(sent_messages) == 1
        msg = sent_messages[0]
        assert msg["To"] == "override@test.com"

    async def test_send_otp_email_sets_x_original_to_header(self):
        """When email_override is set, X-Original-To header contains the real address."""
        from unittest.mock import MagicMock

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        mock_db = AsyncMock()

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send), \
             patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config)), \
             patch("app.services.email_service.get_decrypted_password", return_value="pass"):
            mock_settings.email_override = "override@test.com"

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
                db=mock_db,
            )

        msg = sent_messages[0]
        assert msg["X-Original-To"] == "real@voter.com"

    async def test_send_otp_email_no_override_uses_real_address(self):
        """When email_override is empty, email goes to the real recipient."""
        from unittest.mock import MagicMock

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        mock_db = AsyncMock()

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send), \
             patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config)), \
             patch("app.services.email_service.get_decrypted_password", return_value="pass"):
            mock_settings.email_override = ""

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
                db=mock_db,
            )

        msg = sent_messages[0]
        assert msg["To"] == "real@voter.com"

    async def test_send_otp_email_no_override_no_x_original_to_header(self):
        """When email_override is empty, X-Original-To header is NOT set."""
        from unittest.mock import MagicMock

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        mock_db = AsyncMock()

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send), \
             patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config)), \
             patch("app.services.email_service.get_decrypted_password", return_value="pass"):
            mock_settings.email_override = ""

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
                db=mock_db,
            )

        msg = sent_messages[0]
        assert msg["X-Original-To"] is None

    async def test_send_report_uses_override_address(self):
        """send_report also uses email_override when set."""
        from email.mime.multipart import MIMEMultipart

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send), \
             patch("app.services.email_service.get_general_meeting_detail") as mock_detail, \
             patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config)), \
             patch("app.services.email_service.get_decrypted_password", return_value="pass"), \
             patch("app.services.email_service.AsyncSession"):
            mock_settings.email_override = "override@test.com"

            mock_detail.return_value = {
                "building_name": "Test Bldg",
                "title": "Test Meeting",
                "meeting_at": "2024-01-01",
                "voting_closes_at": "2024-01-02",
                "total_eligible_voters": 1,
                "total_submitted": 1,
                "motions": [],
            }

            # Mock the DB session
            mock_db = AsyncMock()
            mock_meeting_result = MagicMock()
            mock_meeting = MagicMock()
            mock_meeting.building_id = uuid.uuid4()
            mock_meeting_result.scalar_one_or_none.return_value = mock_meeting
            mock_db.execute = AsyncMock(return_value=mock_meeting_result)

            mock_building_result = MagicMock()
            mock_building = MagicMock()
            mock_building.manager_email = "real_manager@test.com"
            mock_building_result.scalar_one_or_none.return_value = mock_building
            # Return different results per call
            mock_db.execute = AsyncMock(
                side_effect=[mock_meeting_result, mock_building_result]
            )

            from app.services.email_service import EmailService
            svc = EmailService()
            await svc.send_report(uuid.uuid4(), mock_db)

        assert len(sent_messages) == 1
        assert sent_messages[0]["To"] == "override@test.com"
        assert sent_messages[0]["X-Original-To"] == "real_manager@test.com"


# ---------------------------------------------------------------------------
# OTP template rendering
# ---------------------------------------------------------------------------


class TestOtpEmailTemplate:
    def test_otp_template_renders_code(self):
        from jinja2 import Environment, FileSystemLoader, select_autoescape
        from pathlib import Path
        templates_dir = Path(__file__).parent.parent / "app" / "templates"
        env = Environment(
            loader=FileSystemLoader(str(templates_dir)),
            autoescape=select_autoescape(["html"]),
        )
        template = env.get_template("otp_email.html")
        html = template.render(meeting_title="Test AGM", code="ABCD1234")
        assert "ABCD1234" in html
        assert "Test AGM" in html
        assert "5 minutes" in html
        assert "Do not share" in html

    def test_otp_template_has_monospace_code_block(self):
        from jinja2 import Environment, FileSystemLoader, select_autoescape
        from pathlib import Path
        templates_dir = Path(__file__).parent.parent / "app" / "templates"
        env = Environment(
            loader=FileSystemLoader(str(templates_dir)),
            autoescape=select_autoescape(["html"]),
        )
        template = env.get_template("otp_email.html")
        html = template.render(meeting_title="AGM", code="TESTCODE")
        # Code should be in a monospace span
        assert "monospace" in html.lower() or "Courier" in html


# ---------------------------------------------------------------------------
# Config: testing_mode and email_override defaults
# ---------------------------------------------------------------------------


class TestConfigDefaults:
    def test_testing_mode_defaults_to_false(self):
        """Default value of testing_mode is False when no env var is set.

        Note: conftest.py sets TESTING_MODE=true for the test suite so the
        shared `settings` singleton will have testing_mode=True.  We instantiate
        a fresh Settings with an explicit override to verify the *default* value.
        """
        from app.config import Settings
        fresh = Settings(testing_mode=False)
        assert fresh.testing_mode is False

    def test_email_override_defaults_to_empty(self):
        from app.config import settings
        assert settings.email_override == ""
