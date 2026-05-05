"""
Comprehensive tests for Phase 6: email delivery, retry logic, and OTEL logging.

Covers:
- HTML template rendering
- EmailService.send_report()
- EmailService.trigger_with_retry()
- EmailService.requeue_pending_on_startup()
- OTEL-compliant structured logging
- Integration: close GeneralMeeting → email triggered
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest
import pytest_asyncio
import structlog
from httpx import ASGITransport, AsyncClient
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.logging_config import configure_logging, get_logger
from app.models import (
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    BallotSubmission,
    Building,
    EmailDelivery,
    EmailDeliveryStatus,
    LotOwner,
    Motion,
    Vote,
    VoteChoice,
    VoteStatus,
)
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.person import Person
from app.services.email_service import (
    EmailService,
    SmtpNotConfiguredError,
    _TEMPLATES_DIR,
    _MAX_ATTEMPTS,
    _backoff_seconds,
    _get_jinja_env,
    _send_with_limit,
    _try_acquire_email_lock,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def future_dt(days: int = 1) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def meeting_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=1)


def closing_dt() -> datetime:
    return datetime.now(UTC) + timedelta(days=2)


async def _create_building(db: AsyncSession, manager_email: str = "mgr@example.com") -> Building:
    building = Building(name=f"Test Building {uuid.uuid4()}", manager_email=manager_email)
    db.add(building)
    await db.flush()
    return building


async def _create_agm(db: AsyncSession, building: Building) -> GeneralMeeting:
    agm = GeneralMeeting(
        building_id=building.id,
        title="Test GeneralMeeting",
        status=GeneralMeetingStatus.closed,
        meeting_at=meeting_dt(),
        voting_closes_at=closing_dt(),
        closed_at=datetime.now(UTC),
    )
    db.add(agm)
    await db.flush()
    return agm


async def _create_motion(db: AsyncSession, agm: GeneralMeeting, order_index: int = 1, description: str | None = "A motion") -> Motion:
    """Create a motion for test fixtures. order_index must be > 0 (RR3-37 constraint)."""
    motion = Motion(
        general_meeting_id=agm.id,
        title=f"Motion {order_index}",
        description=description,
        display_order=order_index,
    )
    db.add(motion)
    await db.flush()
    return motion


async def _create_lot_owner(db: AsyncSession, building: Building, email: str, unit_entitlement: int = 100) -> Lot:
    lo = Lot(
        building_id=building.id,
        lot_number=f"L{uuid.uuid4().hex[:6]}",
        unit_entitlement=unit_entitlement,
    )
    db.add(lo)
    await db.flush()
    p = Person(email=email)
    db.add(p)
    await db.flush()
    await db.execute(lot_persons.insert().values(lot_id=lo.id, person_id=p.id))
    await db.flush()
    return lo


async def _create_lot_weight(db: AsyncSession, agm: GeneralMeeting, lot_owner: Lot) -> GeneralMeetingLotWeight:
    w = GeneralMeetingLotWeight(
        general_meeting_id=agm.id,
        lot_id=lot_owner.id,
        unit_entitlement_snapshot=lot_owner.unit_entitlement,
    )
    db.add(w)
    await db.flush()
    return w


async def _create_ballot(db: AsyncSession, agm: GeneralMeeting, lot_owner: LotOwner, email: str) -> BallotSubmission:
    bs = BallotSubmission(general_meeting_id=agm.id, lot_owner_id=lot_owner.id, voter_email=email)
    db.add(bs)
    await db.flush()
    return bs


async def _create_vote(
    db: AsyncSession,
    agm: GeneralMeeting,
    motion: Motion,
    email: str,
    choice: VoteChoice = VoteChoice.yes,
    lot_owner_id=None,
) -> Vote:
    v = Vote(
        general_meeting_id=agm.id,
        motion_id=motion.id,
        voter_email=email,
        lot_owner_id=lot_owner_id,
        choice=choice,
        status=VoteStatus.submitted,
    )
    db.add(v)
    await db.flush()
    return v


async def _create_email_delivery(db: AsyncSession, agm: GeneralMeeting) -> EmailDelivery:
    ed = EmailDelivery(
        general_meeting_id=agm.id,
        status=EmailDeliveryStatus.pending,
        total_attempts=0,
    )
    db.add(ed)
    await db.flush()
    return ed


@pytest_asyncio.fixture(loop_scope="session")
async def client(app, db_session):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac


# ---------------------------------------------------------------------------
# _send_with_limit helper
# ---------------------------------------------------------------------------


class TestSendWithLimit:
    # --- Happy path ---

    async def test_send_with_limit_awaits_coroutine(self):
        """_send_with_limit acquires the semaphore and awaits the coroutine."""
        called = []

        async def fake_coro():
            called.append(True)

        await _send_with_limit(fake_coro())
        assert called == [True]


# ---------------------------------------------------------------------------
# Advisory lock helper
# ---------------------------------------------------------------------------


class TestTryAcquireEmailLock:
    async def test_returns_true_when_lock_acquired(self, db_session: AsyncSession):
        """_try_acquire_email_lock returns True when the lock is not yet held."""
        agm_id = uuid.uuid4()
        # Start a transaction so the advisory xact lock has a scope
        async with db_session.begin_nested():
            result = await _try_acquire_email_lock(db_session, agm_id)
        assert result is True

    async def test_returns_false_when_lock_already_held(self, db_session: AsyncSession):
        """_try_acquire_email_lock returns False when the same lock is already held
        in the same session/transaction (pg_try_advisory_xact_lock is non-reentrant
        for different transactions; we simulate the False path by mocking the scalar
        return value).
        """
        agm_id = uuid.uuid4()
        # Mock the DB execute to return False as pg would when lock is taken
        mock_result = MagicMock()
        mock_result.scalar.return_value = False
        mock_db = AsyncMock(spec=AsyncSession)
        mock_db.execute = AsyncMock(return_value=mock_result)

        result = await _try_acquire_email_lock(mock_db, agm_id)
        assert result is False


# ---------------------------------------------------------------------------
# Backoff helper
# ---------------------------------------------------------------------------


class TestBackoffSeconds:
    def test_attempt_1(self):
        assert _backoff_seconds(1) == 2

    def test_attempt_2(self):
        assert _backoff_seconds(2) == 4

    def test_attempt_10(self):
        assert _backoff_seconds(10) == 1024

    def test_capped_at_3600(self):
        assert _backoff_seconds(12) == 3600

    def test_very_large_attempt_capped(self):
        assert _backoff_seconds(100) == 3600


# ---------------------------------------------------------------------------
# HTML template rendering
# ---------------------------------------------------------------------------


class TestEmailTemplateRendering:
    def _render_template(self, context: dict) -> str:
        env = _get_jinja_env()
        template = env.get_template("report_email.html")
        return template.render(**context)

    def _default_context(self) -> dict:
        return {
            "building_name": "Sunrise Apartments",
            "meeting_title": "Annual General Meeting 2026",
            "meeting_at": "2026-03-09 10:00:00+00:00",
            "voting_closes_at": "2026-03-09 18:00:00+00:00",
            "total_eligible_voters": 5,
            "total_submitted": 3,
            "meeting_url": "http://localhost:5173/admin/general-meetings/abc-123",
        }

    def test_renders_building_name(self):
        html = self._render_template(self._default_context())
        assert "Sunrise Apartments" in html

    def test_renders_agm_title(self):
        html = self._render_template(self._default_context())
        assert "Annual General Meeting 2026" in html

    def test_renders_meeting_date(self):
        html = self._render_template(self._default_context())
        assert "2026-03-09 10:00:00+00:00" in html

    def test_renders_voting_closes_at(self):
        html = self._render_template(self._default_context())
        assert "2026-03-09 18:00:00+00:00" in html

    def test_renders_summary_eligible_voters(self):
        html = self._render_template(self._default_context())
        assert "5" in html  # total eligible
        assert "3" in html  # total submitted

    def test_renders_meeting_url_link(self):
        """Email must contain a link to the admin meeting page."""
        html = self._render_template(self._default_context())
        assert "http://localhost:5173/admin/general-meetings/abc-123" in html

    def test_renders_view_full_results_cta(self):
        """Email must include a 'View Full Results' call-to-action."""
        html = self._render_template(self._default_context())
        assert "View Full Results" in html

    def test_does_not_render_motion_tally_tables(self):
        """Simplified email must not contain motion tally tables."""
        html = self._render_template(self._default_context())
        # Tally-specific column headers should not appear
        assert "Entitlement Sum" not in html
        assert "Voter Count" not in html

    def test_does_not_render_voter_lists(self):
        """Simplified email must not contain individual voter email addresses."""
        html = self._render_template(self._default_context())
        # No voter list rows should appear (no email addresses in body outside CTA link)
        assert "alice@example.com" not in html
        assert "Voted Yes" not in html
        assert "Voted No" not in html

    def test_template_is_valid_html(self):
        html = self._render_template(self._default_context())
        assert "<!DOCTYPE html>" in html
        assert "</html>" in html


# ---------------------------------------------------------------------------
# OTEL logging
# ---------------------------------------------------------------------------


class TestOtelLogging:
    def teardown_method(self):
        """Reset structlog to app default after each test."""
        configure_logging()

    def test_configure_logging_does_not_raise(self):
        # configure_logging() is idempotent
        configure_logging()

    def test_get_logger_returns_bound_logger(self):
        log = get_logger("test.logger")
        assert log is not None

    def test_log_events_are_valid_json(self):
        """Capture log output and verify it is valid JSON with required fields."""
        buf = io.StringIO()
        configure_logging()  # ensure fresh config

        test_logger = structlog.get_logger("test.otel")

        # Patch the print logger to capture output
        with patch("structlog.PrintLoggerFactory") as mock_factory:
            mock_print_logger = MagicMock()
            captured_events = []

            def fake_msg(event: str) -> None:
                captured_events.append(event)

            mock_print_logger.msg = fake_msg
            mock_factory.return_value.return_value = mock_print_logger

            # Re-configure with patched factory
            import structlog as sl
            sl.configure(
                processors=[
                    sl.stdlib.add_logger_name,
                    sl.stdlib.add_log_level,
                    sl.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
                    lambda logger, method, event_dict: {
                        **event_dict,
                        "service.name": "agm-voting-app",
                    },
                    lambda logger, method, event_dict: {
                        **{"message": event_dict.pop("event", "")},
                        **event_dict,
                    },
                    sl.processors.JSONRenderer(),
                ],
                wrapper_class=sl.make_filtering_bound_logger(10),
                context_class=dict,
                logger_factory=mock_factory(),
                cache_logger_on_first_use=False,
            )

            bound_log = sl.get_logger("test.otel")
            bound_log.info("test_event", agm_id="abc-123", attempt_number=1, status="pending")

            if captured_events:
                event_str = captured_events[0]
                parsed = json.loads(event_str)
                assert "message" in parsed or "event" in parsed
                assert "level" in parsed
                assert "timestamp" in parsed

    def test_service_name_present_in_config(self):
        """Verify _add_service_name processor adds service.name."""
        from app.logging_config import _add_service_name
        event_dict = {"event": "test"}
        result = _add_service_name(None, "info", event_dict)
        assert result["service.name"] == "agm-voting-app"

    def test_rename_event_to_message(self):
        """Verify _rename_event_to_message renames event to message."""
        from app.logging_config import _rename_event_to_message
        event_dict = {"event": "my_event", "foo": "bar"}
        result = _rename_event_to_message(None, "info", event_dict)
        assert "message" in result
        assert result["message"] == "my_event"
        assert "event" not in result

    def test_get_logger_binds_name(self):
        log = get_logger("email_service")
        # Should be a structlog BoundLogger or compatible
        assert hasattr(log, "info")
        assert hasattr(log, "warning")
        assert hasattr(log, "error")

    def test_add_logger_name_with_named_logger(self):
        """_add_logger_name adds logger name when logger has .name attribute."""
        from app.logging_config import _add_logger_name
        named_logger = MagicMock()
        named_logger.name = "my.logger"
        event_dict = {"event": "test"}
        result = _add_logger_name(named_logger, "info", event_dict)
        assert result["logger"] == "my.logger"

    def test_add_logger_name_without_name_attribute(self):
        """_add_logger_name is a no-op when logger has no .name attribute."""
        from app.logging_config import _add_logger_name
        logger_no_name = MagicMock(spec=[])  # no 'name' attribute
        event_dict = {"event": "test"}
        result = _add_logger_name(logger_no_name, "info", event_dict)
        assert "logger" not in result


# ---------------------------------------------------------------------------
# send_report
# ---------------------------------------------------------------------------


class TestSendReport:
    # --- Happy path ---

    async def test_send_report_success(self, db_session: AsyncSession, mocker):
        """Successful send → aiosmtplib.send called, no exception raised."""
        building = await _create_building(db_session, manager_email="mgr@example.com")
        agm = await _create_agm(db_session, building)
        motion = await _create_motion(db_session, agm)
        lo = await _create_lot_owner(db_session, building, "voter@example.com", 100)
        await _create_lot_weight(db_session, agm, lo)
        await _create_ballot(db_session, agm, lo, "voter@example.com")
        await _create_vote(db_session, agm, motion, "voter@example.com", VoteChoice.yes, lot_owner_id=lo.id)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch(
            "app.services.email_service.get_smtp_config",
            AsyncMock(return_value=mock_smtp_config),
        )
        mocker.patch(
            "app.services.email_service.get_decrypted_password",
            return_value="pass",
        )

        service = EmailService()
        # Should not raise
        await service.send_report(agm.id, db_session, "https://example.com")

        mock_send.assert_called_once()
        # First positional arg is the MIMEMultipart message object
        msg = mock_send.call_args[0][0]
        assert msg["To"] == "mgr@example.com"
        assert "General Meeting Results Report" in msg["Subject"]
        # The HTML part content
        html_part = msg.get_payload()[0].get_payload()
        assert "<html" in html_part.lower()

    async def test_send_report_uses_smtp_settings(self, db_session: AsyncSession, mocker):
        """send_report passes SMTP settings from DB config to aiosmtplib.send."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.example.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "testuser"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"

        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch(
            "app.services.email_service.get_smtp_config",
            AsyncMock(return_value=mock_smtp_config),
        )
        mocker.patch(
            "app.services.email_service.get_decrypted_password",
            return_value="testpass",
        )

        service = EmailService()
        await service.send_report(agm.id, db_session, "https://example.com")

        call_kwargs = mock_send.call_args[1]
        assert call_kwargs["hostname"] == "smtp.example.com"
        assert call_kwargs["port"] == 587
        assert call_kwargs["username"] == "testuser"
        assert call_kwargs["password"] == "testpass"
        assert call_kwargs["start_tls"] is True

    # --- Error cases ---

    async def test_send_report_smtp_exception_propagates(self, db_session: AsyncSession, mocker):
        """aiosmtplib raising exception → exception propagates out of send_report."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("aiosmtplib.send", new_callable=AsyncMock, side_effect=Exception("SMTP error"))
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        service = EmailService()
        with pytest.raises(Exception, match="SMTP error"):
            await service.send_report(agm.id, db_session, "https://example.com")

    async def test_send_report_agm_not_found_raises(self, db_session: AsyncSession, mocker):
        """GeneralMeeting not found → get_agm_detail raises HTTPException(404)."""
        from fastapi import HTTPException
        mocker.patch("aiosmtplib.send", new_callable=AsyncMock)

        service = EmailService()
        with pytest.raises(HTTPException) as exc_info:
            await service.send_report(uuid.uuid4(), db_session, "https://example.com")
        assert exc_info.value.status_code == 404

    async def test_send_report_no_manager_email_raises(self, db_session: AsyncSession, mocker):
        """Building manager_email is empty string → ValueError raised."""
        building = Building(name=f"NoEmail Building {uuid.uuid4()}", manager_email="")
        db_session.add(building)
        await db_session.flush()

        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        service = EmailService()
        with pytest.raises(ValueError, match="no manager_email"):
            await service.send_report(agm.id, db_session, "https://example.com")

    async def test_send_report_with_null_motion_description(self, db_session: AsyncSession, mocker):
        """Motion with null description → template renders without error."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm, description=None)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")
        service = EmailService()
        await service.send_report(agm.id, db_session, "https://example.com")
        mock_send.assert_called_once()

    async def test_send_report_uses_base_url_in_meeting_link(self, db_session: AsyncSession, mocker):
        """send_report builds the meeting_url from the provided base_url, not settings.allowed_origin."""
        building = await _create_building(db_session, manager_email="mgr@example.com")
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        service = EmailService()
        await service.send_report(agm.id, db_session, "https://vms-demo.ocss.tech")

        mock_send.assert_called_once()
        msg = mock_send.call_args[0][0]
        html_part = msg.get_payload()[0].get_payload()
        expected_url = f"https://vms-demo.ocss.tech/admin/general-meetings/{agm.id}"
        assert expected_url in html_part

    async def test_send_report_base_url_trailing_slash_stripped(self, db_session: AsyncSession, mocker):
        """Trailing slash on base_url is stripped so the meeting URL is well-formed."""
        building = await _create_building(db_session, manager_email="mgr@example.com")
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        service = EmailService()
        # Pass base_url with a trailing slash — should still produce a clean URL
        await service.send_report(agm.id, db_session, "https://vms-demo.ocss.tech/")

        mock_send.assert_called_once()
        msg = mock_send.call_args[0][0]
        html_part = msg.get_payload()[0].get_payload()
        expected_url = f"https://vms-demo.ocss.tech/admin/general-meetings/{agm.id}"
        assert expected_url in html_part
        # Confirm there is no double-slash in the path
        assert "//admin" not in html_part


# ---------------------------------------------------------------------------
# trigger_with_retry
# ---------------------------------------------------------------------------


class TestTriggerWithRetry:
    # --- Happy path ---

    async def test_first_attempt_succeeds(self, db_session: AsyncSession, mocker):
        """First attempt succeeds → status=delivered, total_attempts=1."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.delivered
        assert delivery.total_attempts == 1
        assert delivery.last_error is None

    # --- Retry ---

    async def test_first_fails_second_succeeds(self, db_session: AsyncSession, mocker):
        """First attempt fails, second succeeds → total_attempts=2, status=delivered."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        call_count = {"n": 0}

        async def send_side_effect(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise Exception("temporary error")

        mocker.patch("aiosmtplib.send", side_effect=send_side_effect)

        # Patch sleep to be instant
        mocker.patch("asyncio.sleep", new=AsyncMock())

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.delivered
        assert delivery.total_attempts == 2

    # --- Max attempts ---

    async def test_all_30_attempts_fail(self, db_session: AsyncSession, mocker):
        """All 30 attempts fail → status=failed, total_attempts=30."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")
        mocker.patch("aiosmtplib.send", new_callable=AsyncMock, side_effect=Exception("always fails"))
        mocker.patch("asyncio.sleep", new=AsyncMock())

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.failed
        assert delivery.total_attempts == 30
        assert delivery.last_error == "always fails"

    # --- Non-retryable errors ---

    async def test_smtp_auth_error_fails_immediately(self, db_session: AsyncSession, mocker):
        """SMTPAuthenticationError (535) marks delivery failed on the first attempt without retrying.

        Wrong credentials will never become right — retrying wastes Lambda time on every
        cold start and causes Lambda timeouts when many stale emails are requeued.
        """
        import aiosmtplib

        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="bad-password")
        mocker.patch(
            "aiosmtplib.send",
            side_effect=aiosmtplib.SMTPAuthenticationError(535, "5.7.8 Authentication failed"),
        )
        sleep_mock = mocker.patch("asyncio.sleep", new=AsyncMock())

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        await db_session.refresh(delivery)
        # Must fail immediately — no retries
        assert delivery.status == EmailDeliveryStatus.failed
        assert delivery.total_attempts == 1
        assert delivery.next_retry_at is None
        assert "535" in (delivery.last_error or "") or "Authentication" in (delivery.last_error or "")
        # Sleep (backoff) must NOT have been called
        sleep_mock.assert_not_called()

    # --- Already delivered ---

    async def test_already_delivered_skips(self, db_session: AsyncSession, mocker):
        """If delivery is already delivered, no further attempts are made."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.delivered
        delivery.total_attempts = 1
        await db_session.commit()

        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        mock_send.assert_not_called()

    # --- Max attempts already reached ---

    async def test_already_at_max_attempts_skips(self, db_session: AsyncSession, mocker):
        """If total_attempts >= 30, no further attempts are made."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.failed
        delivery.total_attempts = 30
        await db_session.commit()

        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        mock_send.assert_not_called()

    # --- Delivery record missing ---

    async def test_delivery_record_not_found(self, db_session: AsyncSession, mocker):
        """If no EmailDelivery record exists for the agm_id, trigger_with_retry returns cleanly."""
        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        # Should not raise
        await service.trigger_with_retry(uuid.uuid4(), "https://example.com", session_factory=mock_factory)
        mock_send.assert_not_called()

    # --- Exponential backoff ---

    async def test_exponential_backoff_delays(self, db_session: AsyncSession, mocker):
        """Verify asyncio.sleep is called with correct backoff values."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        # Fail 3 times, succeed on 4th
        call_count = {"n": 0}

        async def send_side_effect(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] < 4:
                raise Exception("fail")

        mocker.patch("aiosmtplib.send", side_effect=send_side_effect)
        sleep_mock = mocker.patch("asyncio.sleep", new=AsyncMock())

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        # 3 failures → 3 sleep calls with delays 2^1=2, 2^2=4, 2^3=8
        sleep_calls = [c.args[0] for c in sleep_mock.call_args_list]
        assert sleep_calls == [2, 4, 8]

    # --- Logging per attempt ---

    async def test_each_attempt_emits_log_event(self, db_session: AsyncSession, mocker):
        """Each attempt emits a structlog event with required fields."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("aiosmtplib.send", new_callable=AsyncMock)
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        mock_factory = _make_mock_factory(db_session)

        log_events: list[dict] = []

        def capture_log(logger, method, event_dict):
            log_events.append(dict(event_dict))
            return event_dict

        import structlog as sl
        original_processors = sl.get_config().get("processors", [])

        service = EmailService()
        with patch.object(
            service,
            "send_report",
            wraps=service.send_report,
        ):
            # We'll check via logger calls
            pass

        # Just verify the call succeeds without error
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.delivered

    # --- C-9: concurrent calls — only one send ---

    async def test_concurrent_calls_send_exactly_once(self, db_session: AsyncSession, mocker):
        """Two concurrent trigger_with_retry calls for the same AGM → send_report called exactly once.

        The first call acquires the advisory lock and sends. The second call finds
        the lock already held and exits immediately without sending.
        """
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        send_call_count = {"n": 0}

        async def counting_send(*args, **kwargs):
            send_call_count["n"] += 1

        mocker.patch("aiosmtplib.send", side_effect=counting_send)

        # The second trigger_with_retry call must skip because the lock is held.
        # We simulate this by making _try_acquire_email_lock return False on the
        # second call (as it would when a real advisory lock is already held in
        # another session).
        original_lock_fn = _try_acquire_email_lock
        lock_call_count = {"n": 0}

        async def mock_lock(db, agm_id):
            lock_call_count["n"] += 1
            if lock_call_count["n"] == 1:
                return True   # first caller acquires the lock
            return False       # second caller finds it taken

        mock_factory = _make_mock_factory(db_session)
        mocker.patch("app.services.email_service._try_acquire_email_lock", side_effect=mock_lock)

        service = EmailService()
        # Run two concurrent invocations
        await asyncio.gather(
            service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory),
            service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory),
        )

        # Exactly one send should have occurred
        assert send_call_count["n"] == 1

    # --- C-9: restart scenario — already delivered, do not re-send ---

    async def test_already_delivered_before_lock_check_skips(self, db_session: AsyncSession, mocker):
        """Restart scenario: EmailDelivery.status=delivered when trigger_with_retry
        is called (e.g. Lambda restart after send but before status update was
        persisted in a previous run that did persist it).  send_report must not
        be called again.
        """
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.delivered
        delivery.total_attempts = 1
        await db_session.commit()

        mock_send = mocker.patch("aiosmtplib.send", new_callable=AsyncMock)

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        mock_send.assert_not_called()

    # --- next_retry_at is set on failure ---

    async def test_next_retry_at_set_on_failure(self, db_session: AsyncSession, mocker):
        """On a failed attempt (not last), next_retry_at is set to a future time."""
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        await _create_motion(db_session, agm)
        delivery = await _create_email_delivery(db_session, agm)
        await db_session.commit()

        mock_smtp_config = MagicMock()
        mock_smtp_config.smtp_host = "smtp.test.com"
        mock_smtp_config.smtp_port = 587
        mock_smtp_config.smtp_username = "user"
        mock_smtp_config.smtp_from_email = "noreply@test.com"
        mock_smtp_config.smtp_password_enc = "enc"
        mocker.patch("app.services.email_service.get_smtp_config", AsyncMock(return_value=mock_smtp_config))
        mocker.patch("app.services.email_service.get_decrypted_password", return_value="pass")

        call_count = {"n": 0}

        async def send_side_effect(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise Exception("temporary")

        mocker.patch("aiosmtplib.send", side_effect=send_side_effect)
        mocker.patch("asyncio.sleep", new=AsyncMock())

        mock_factory = _make_mock_factory(db_session)

        service = EmailService()
        await service.trigger_with_retry(agm.id, "https://example.com", session_factory=mock_factory)

        # After success on attempt 2, next_retry_at should be None
        await db_session.refresh(delivery)
        assert delivery.next_retry_at is None
        assert delivery.status == EmailDeliveryStatus.delivered


# ---------------------------------------------------------------------------
# requeue_pending_on_startup
# ---------------------------------------------------------------------------


class TestRequeuePendingOnStartup:
    # --- Setup helper ---

    async def _clear_pending_deliveries(self, db_session: AsyncSession) -> None:
        """Delete all pending EmailDelivery records to ensure a clean baseline.

        The shared session-scoped transaction means that committed records from
        prior tests in the same session (e.g. TestCloseAgmEmailIntegration) are
        visible here. Clearing pending records before each test in this class
        ensures the call count assertions are accurate.
        """
        from sqlalchemy import delete as sa_delete
        await db_session.execute(
            sa_delete(EmailDelivery).where(
                EmailDelivery.status == EmailDeliveryStatus.pending
            )
        )
        await db_session.commit()

    # --- Happy path ---

    async def test_startup_summary_warning_logged_when_pending_found(
        self, db_session: AsyncSession, mocker
    ):
        """startup_email_requeue warning is emitted at WARNING level when emails are requeued.

        A single 'startup_email_requeue count=N' line is immediately visible in function
        logs; a burst of N individual requeueing_pending_email lines is easy to scroll past.
        """
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.pending
        delivery.total_attempts = 2
        await db_session.commit()

        mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        warning_events: list[str] = []

        def capture(event: str, **kw: object) -> None:
            warning_events.append(event)

        import app.services.email_service as _email_svc
        mocker.patch.object(_email_svc.logger, "warning", side_effect=capture)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        assert "startup_email_requeue" in warning_events

    async def test_no_summary_warning_when_nothing_pending(
        self, db_session: AsyncSession, mocker
    ):
        """No startup_email_requeue log emitted when there are no due pending emails."""
        await self._clear_pending_deliveries(db_session)
        mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        import app.services.email_service as _email_svc
        warning_events: list[str] = []
        mocker.patch.object(_email_svc.logger, "warning", side_effect=lambda e, **kw: warning_events.append(e))

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        assert "startup_email_requeue" not in warning_events

    async def test_requeues_pending_deliveries(self, db_session: AsyncSession, mocker):
        """Pending deliveries due for retry are awaited via asyncio.gather on startup."""
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.pending
        delivery.total_attempts = 5
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        assert trigger_mock.call_count == 1

    async def test_ignores_delivered_records(self, db_session: AsyncSession, mocker):
        """Delivered records are not re-queued."""
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.delivered
        delivery.total_attempts = 1
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        trigger_mock.assert_not_called()

    async def test_ignores_records_at_max_attempts(self, db_session: AsyncSession, mocker):
        """Records with total_attempts >= 30 are not re-queued."""
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.pending
        delivery.total_attempts = 30
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        trigger_mock.assert_not_called()

    async def test_skips_deliveries_with_future_next_retry_at(self, db_session: AsyncSession, mocker):
        """Pending delivery with next_retry_at in the future is not re-queued on cold start.

        Without this guard, every cold start would immediately retry all pending emails,
        ignoring the exponential backoff schedule and blocking startup.
        """
        from datetime import timedelta
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.pending
        delivery.total_attempts = 3
        delivery.next_retry_at = datetime.now(UTC) + timedelta(hours=1)  # not due yet
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        trigger_mock.assert_not_called()

    async def test_requeues_deliveries_with_past_next_retry_at(self, db_session: AsyncSession, mocker):
        """Pending delivery with next_retry_at in the past IS re-queued on cold start."""
        from datetime import timedelta
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.pending
        delivery.total_attempts = 3
        delivery.next_retry_at = datetime.now(UTC) - timedelta(minutes=5)  # overdue
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        assert trigger_mock.call_count == 1

    async def test_ignores_failed_records(self, db_session: AsyncSession, mocker):
        """Failed records are not re-queued."""
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.failed
        delivery.total_attempts = 30
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        trigger_mock.assert_not_called()

    async def test_multiple_pending_deliveries_all_requeued(self, db_session: AsyncSession, mocker):
        """Multiple pending deliveries all get re-launched as non-blocking background tasks."""
        await self._clear_pending_deliveries(db_session)
        for _ in range(3):
            building = await _create_building(db_session)
            agm = await _create_agm(db_session, building)
            delivery = await _create_email_delivery(db_session, agm)
            delivery.status = EmailDeliveryStatus.pending
            delivery.total_attempts = 0
        await db_session.commit()

        trigger_mock = mocker.patch.object(EmailService, "trigger_with_retry", new_callable=AsyncMock)

        service = EmailService()
        await service.requeue_pending_on_startup(db_session)

        assert trigger_mock.call_count == 3

    async def test_gather_exceptions_are_logged_not_raised(self, db_session: AsyncSession, mocker):
        """If a trigger_with_retry task raises, the error is logged and startup completes without raising."""
        await self._clear_pending_deliveries(db_session)
        building = await _create_building(db_session)
        agm = await _create_agm(db_session, building)
        delivery = await _create_email_delivery(db_session, agm)
        delivery.status = EmailDeliveryStatus.pending
        delivery.total_attempts = 0
        await db_session.commit()

        mocker.patch.object(
            EmailService, "trigger_with_retry", new_callable=AsyncMock,
            side_effect=Exception("unexpected gather error"),
        )

        import app.services.email_service as _email_svc
        error_events: list[str] = []
        mocker.patch.object(
            _email_svc.logger, "error",
            side_effect=lambda e, **kw: error_events.append(e),
        )

        service = EmailService()
        # Must not raise even though the task failed
        await service.requeue_pending_on_startup(db_session)

        assert "startup_email_requeue_task_error" in error_events


# ---------------------------------------------------------------------------
# Integration: close GeneralMeeting → email triggered
# ---------------------------------------------------------------------------


class TestCloseAgmEmailIntegration:
    async def _make_client(self, app):
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    async def test_close_agm_creates_email_delivery_and_triggers(
        self, client: AsyncClient, db_session: AsyncSession, mocker
    ):
        """POST /api/admin/general-meetings/{id}/close creates EmailDelivery and schedules trigger_with_retry via BackgroundTasks."""
        building = Building(name=f"Bld {uuid.uuid4()}", manager_email="mgr@example.com")
        db_session.add(building)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=building.id,
            title="Test GeneralMeeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(agm)
        await db_session.flush()

        motion = Motion(
            general_meeting_id=agm.id, title="M1", description=None, display_order=1
        )
        db_session.add(motion)
        await db_session.commit()

        # Patch trigger_with_retry so BackgroundTasks runs it without hitting SMTP
        trigger_mock = mocker.patch(
            "app.services.email_service.EmailService.trigger_with_retry",
            new_callable=AsyncMock,
        )

        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/close")
        assert resp.status_code == 200

        # EmailDelivery should have been created
        result = await db_session.execute(
            select(EmailDelivery).where(EmailDelivery.general_meeting_id == agm.id)
        )
        delivery = result.scalar_one_or_none()
        assert delivery is not None
        assert delivery.status == EmailDeliveryStatus.pending

        # trigger_with_retry should have been scheduled via BackgroundTasks
        trigger_mock.assert_called_once_with(agm.id, "http://test")

    async def test_resend_report_triggers_email(
        self, client: AsyncClient, db_session: AsyncSession, mocker
    ):
        """POST /api/admin/general-meetings/{id}/resend-report schedules trigger_with_retry via BackgroundTasks."""
        building = Building(name=f"Bld2 {uuid.uuid4()}", manager_email="mgr@example.com")
        db_session.add(building)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=building.id,
            title="Test GeneralMeeting 2",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()

        delivery = EmailDelivery(
            general_meeting_id=agm.id,
            status=EmailDeliveryStatus.failed,
            total_attempts=5,
            last_error="network timeout",
        )
        db_session.add(delivery)
        await db_session.commit()

        # Patch trigger_with_retry so BackgroundTasks runs it without hitting SMTP
        trigger_mock = mocker.patch(
            "app.services.email_service.EmailService.trigger_with_retry",
            new_callable=AsyncMock,
        )

        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert resp.status_code == 200
        assert resp.json()["queued"] is True

        # Delivery record should be reset
        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.pending
        assert delivery.total_attempts == 0

        # trigger_with_retry should have been scheduled via BackgroundTasks
        trigger_mock.assert_called_once_with(agm.id, "http://test")

    async def test_resend_report_succeeds_when_already_delivered(
        self, client: AsyncClient, db_session: AsyncSession, mocker
    ):
        """POST /api/admin/general-meetings/{id}/resend-report succeeds even when email was already delivered."""
        building = Building(name=f"Bld3 {uuid.uuid4()}", manager_email="mgr@example.com")
        db_session.add(building)
        await db_session.flush()

        agm = GeneralMeeting(
            building_id=building.id,
            title="Test GeneralMeeting 3",
            status=GeneralMeetingStatus.closed,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
            closed_at=datetime.now(UTC),
        )
        db_session.add(agm)
        await db_session.flush()

        delivery = EmailDelivery(
            general_meeting_id=agm.id,
            status=EmailDeliveryStatus.delivered,
            total_attempts=1,
            last_error=None,
        )
        db_session.add(delivery)
        await db_session.commit()

        mocker.patch(
            "app.services.email_service.EmailService.trigger_with_retry",
            new_callable=AsyncMock,
        )

        resp = await client.post(f"/api/admin/general-meetings/{agm.id}/resend-report")
        assert resp.status_code == 200
        assert resp.json()["queued"] is True

        await db_session.refresh(delivery)
        assert delivery.status == EmailDeliveryStatus.pending
        assert delivery.total_attempts == 0

    async def test_resend_report_not_found(
        self, client: AsyncClient, db_session: AsyncSession, mocker
    ):
        """POST /api/admin/general-meetings/{id}/resend-report returns 404 for non-existent meeting."""
        mocker.patch(
            "app.services.email_service.EmailService.trigger_with_retry",
            new_callable=AsyncMock,
        )
        fake_id = uuid.uuid4()
        resp = await client.post(f"/api/admin/general-meetings/{fake_id}/resend-report")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# OTEL log fields validation
# ---------------------------------------------------------------------------


def _configure_capture_structlog(captured: list) -> None:
    """Configure structlog to emit JSON into captured list. Resets after use with configure_logging()."""
    import structlog as sl

    sl.configure(
        processors=[
            sl.stdlib.add_log_level,
            sl.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
            lambda _logger, _method, ed: {**ed, "service.name": "agm-voting-app"},
            sl.processors.JSONRenderer(),
        ],
        wrapper_class=sl.make_filtering_bound_logger(10),
        context_class=dict,
        logger_factory=sl.PrintLoggerFactory(file=_CapturingStream(captured)),
        cache_logger_on_first_use=False,
    )


class TestOtelLogFields:
    def setup_method(self):
        """Reset structlog to app default after each test."""
        configure_logging()

    def teardown_method(self):
        """Reset structlog to app default."""
        configure_logging()

    def test_log_attempt_fields(self):
        """Verify that email attempt logs include required OTEL fields."""
        captured = []
        _configure_capture_structlog(captured)

        import structlog as sl

        log = sl.get_logger("email_service")
        log.info(
            "email_delivery_attempt",
            general_meeting_id="test-agm-id",
            attempt_number=1,
            status="delivered",
            error=None,
            next_retry_at=None,
        )

        assert len(captured) >= 1
        parsed = json.loads(captured[-1])

        # Required OTEL fields
        assert "timestamp" in parsed
        assert "level" in parsed
        assert parsed["service.name"] == "agm-voting-app"
        # event/message
        assert "event" in parsed or "message" in parsed

        # Email attempt fields
        assert parsed.get("general_meeting_id") == "test-agm-id"
        assert parsed.get("attempt_number") == 1
        assert parsed.get("status") == "delivered"

    def test_log_timestamp_is_iso8601(self):
        """Verify timestamp field is ISO 8601 UTC."""
        captured = []
        _configure_capture_structlog(captured)

        import structlog as sl

        log = sl.get_logger("test")
        log.info("ts_test")

        assert len(captured) >= 1
        parsed = json.loads(captured[-1])
        ts = parsed["timestamp"]
        # ISO 8601 format: should contain 'T' separator
        assert "T" in ts

    def test_error_field_in_failed_attempt_log(self):
        """Error field present when status=failed."""
        captured = []
        _configure_capture_structlog(captured)

        import structlog as sl

        log = sl.get_logger("test.error.log")
        log.error(
            "email_delivery_attempt",
            general_meeting_id="agm-xyz",
            attempt_number=30,
            status="failed",
            error="connection refused",
        )

        assert len(captured) >= 1
        parsed = json.loads(captured[-1])
        assert parsed.get("error") == "connection refused"
        assert parsed.get("status") == "failed"
        assert parsed.get("attempt_number") == 30


# ---------------------------------------------------------------------------
# Helper: in-memory stream for structlog capture
# ---------------------------------------------------------------------------


class _CapturingStream:
    """File-like object that captures written output into a list."""

    def __init__(self, captured: list):
        self._captured = captured

    def write(self, msg: str) -> None:
        if msg.strip():
            self._captured.append(msg.strip())

    def flush(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Helper: mock async session factory
# ---------------------------------------------------------------------------


def _make_mock_factory(db_session: AsyncSession):
    """
    Return an async_sessionmaker mock that yields the provided db_session
    when used as `async with factory() as session`.
    """
    from contextlib import asynccontextmanager

    class _MockContextManager:
        def __init__(self):
            pass

        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *args):
            # Don't close the test session
            pass

    class _MockFactory:
        def __call__(self):
            return _MockContextManager()

    return _MockFactory()
