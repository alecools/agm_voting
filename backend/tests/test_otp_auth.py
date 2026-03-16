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
)
from app.models.lot_owner_email import LotOwnerEmail
from app.routers.auth import _generate_otp_code, _OTP_ALPHABET, _otp_rate_limit


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
        """Second request within 60s returns 429."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        # Pre-seed the rate limit dict with a recent timestamp
        rate_key = (voter_email, agm.id)
        _otp_rate_limit[rate_key] = datetime.now(UTC)

        try:
            with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock):
                response = await client.post(
                    "/api/auth/request-otp",
                    json={"email": voter_email, "general_meeting_id": str(agm.id)},
                )
            assert response.status_code == 429
            assert "Please wait" in response.json()["detail"]
        finally:
            _otp_rate_limit.pop(rate_key, None)

    async def test_request_otp_smtp_failure_returns_500(
        self, client: AsyncClient, db_session: AsyncSession, building_and_meeting: dict
    ):
        """SMTP failure → 500."""
        voter_email = building_and_meeting["voter_email"]
        agm = building_and_meeting["agm"]

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = Exception("SMTP connection refused")
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(agm.id)},
            )
        assert response.status_code == 500

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

        # Clear rate limit so we can resend
        _otp_rate_limit.pop((voter_email, agm.id), None)

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

        _otp_rate_limit.pop((voter_email, expired_agm.id), None)

        with patch("app.routers.auth.send_otp_email", new_callable=AsyncMock) as mock_send:
            response = await client.post(
                "/api/auth/request-otp",
                json={"email": voter_email, "general_meeting_id": str(expired_agm.id)},
            )

        assert response.status_code == 200
        mock_send.assert_awaited_once()


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

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send):
            mock_settings.testing_mode = False
            mock_settings.email_override = "override@test.com"
            mock_settings.smtp_from_email = "noreply@test.com"
            mock_settings.smtp_host = "smtp.test.com"
            mock_settings.smtp_port = 587
            mock_settings.smtp_username = "user"
            mock_settings.smtp_password = "pass"

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
            )

        assert len(sent_messages) == 1
        msg = sent_messages[0]
        assert msg["To"] == "override@test.com"

    async def test_send_otp_email_sets_x_original_to_header(self):
        """When email_override is set, X-Original-To header contains the real address."""
        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send):
            mock_settings.testing_mode = False
            mock_settings.email_override = "override@test.com"
            mock_settings.smtp_from_email = "noreply@test.com"
            mock_settings.smtp_host = "smtp.test.com"
            mock_settings.smtp_port = 587
            mock_settings.smtp_username = "user"
            mock_settings.smtp_password = "pass"

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
            )

        msg = sent_messages[0]
        assert msg["X-Original-To"] == "real@voter.com"

    async def test_send_otp_email_no_override_uses_real_address(self):
        """When email_override is empty, email goes to the real recipient."""
        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send):
            mock_settings.testing_mode = False
            mock_settings.email_override = ""
            mock_settings.smtp_from_email = "noreply@test.com"
            mock_settings.smtp_host = "smtp.test.com"
            mock_settings.smtp_port = 587
            mock_settings.smtp_username = "user"
            mock_settings.smtp_password = "pass"

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
            )

        msg = sent_messages[0]
        assert msg["To"] == "real@voter.com"

    async def test_send_otp_email_no_override_no_x_original_to_header(self):
        """When email_override is empty, X-Original-To header is NOT set."""
        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send):
            mock_settings.testing_mode = False
            mock_settings.email_override = ""
            mock_settings.smtp_from_email = "noreply@test.com"
            mock_settings.smtp_host = "smtp.test.com"
            mock_settings.smtp_port = 587
            mock_settings.smtp_username = "user"
            mock_settings.smtp_password = "pass"

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
            )

        msg = sent_messages[0]
        assert msg["X-Original-To"] is None

    async def test_send_otp_email_skips_smtp_in_testing_mode(self):
        """When testing_mode is True, SMTP is not called — OTP is in DB only."""
        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send):
            mock_settings.testing_mode = True

            from app.services.email_service import send_otp_email
            await send_otp_email(
                to_email="real@voter.com",
                meeting_title="Test Meeting",
                code="ABCD1234",
            )

        # No email should have been sent
        assert len(sent_messages) == 0

    async def test_send_report_uses_override_address(self):
        """send_report also uses email_override when set."""
        from email.mime.multipart import MIMEMultipart

        sent_messages = []

        async def mock_send(message, **kwargs):
            sent_messages.append(message)

        with patch("app.services.email_service.settings") as mock_settings, \
             patch("app.services.email_service.aiosmtplib.send", side_effect=mock_send), \
             patch("app.services.email_service.get_general_meeting_detail") as mock_detail, \
             patch("app.services.email_service.AsyncSession"):
            mock_settings.email_override = "override@test.com"
            mock_settings.smtp_from_email = "noreply@test.com"
            mock_settings.smtp_host = "smtp.test.com"
            mock_settings.smtp_port = 587
            mock_settings.smtp_username = "user"
            mock_settings.smtp_password = "pass"

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
        from app.config import settings
        assert settings.testing_mode is False

    def test_email_override_defaults_to_empty(self):
        from app.config import settings
        assert settings.email_override == ""
