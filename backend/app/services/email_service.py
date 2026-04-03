"""
Email service for AGM results report delivery via SMTP (aiosmtplib).

Provides:
- send_report(): render the HTML template and send via SMTP with STARTTLS
- trigger_with_retry(): background task with exponential backoff, up to 30 attempts
- requeue_pending_on_startup(): re-launch retry tasks for pending deliveries on startup
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import aiosmtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.logging_config import get_logger
from app.services.smtp_config_service import get_smtp_config, get_decrypted_password
from app.models import (
    GeneralMeeting,
    GeneralMeetingLotWeight,
    BallotSubmission,
    EmailDelivery,
    EmailDeliveryStatus,
    Motion,
    Vote,
    VoteStatus,
)
from app.models.building import Building
from app.services.admin_service import get_general_meeting_detail

logger = get_logger(__name__)


class SmtpNotConfiguredError(Exception):
    """Raised when the DB SMTP configuration is missing or incomplete.

    This is a non-retryable failure: trigger_with_retry sets status=failed
    immediately when this exception is raised.
    """


_TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
_MAX_ATTEMPTS = 30
_BACKOFF_CAP_SECONDS = 3600

# Semaphore to cap concurrent outbound email sends at 10.
# This prevents thundering-herd scenarios on startup requeue or meeting close
# from exhausting SMTP connection limits.
_email_semaphore = asyncio.Semaphore(10)


async def _send_with_limit(coro: object) -> None:  # type: ignore[type-arg]
    """Acquire the global email semaphore then await the given coroutine."""
    async with _email_semaphore:
        await coro  # type: ignore[misc]


async def _try_acquire_email_lock(db: AsyncSession, agm_id: uuid.UUID) -> bool:
    """
    Attempt to acquire a PostgreSQL advisory transaction lock keyed on agm_id.

    Uses pg_try_advisory_xact_lock so the lock is held until the end of the
    current transaction and is automatically released on commit/rollback.
    Returns True if the lock was acquired (this caller owns it), False if
    another session already holds the lock for the same agm_id.
    """
    lock_id = int(hashlib.sha256(str(agm_id).encode()).hexdigest()[:8], 16) % 2147483647
    result = await db.execute(text(f"SELECT pg_try_advisory_xact_lock({lock_id})"))
    return bool(result.scalar())


def _get_jinja_env() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(_TEMPLATES_DIR)),
        autoescape=select_autoescape(["html"]),
    )


def _backoff_seconds(attempt: int) -> int:
    """Return exponential backoff delay in seconds, capped at _BACKOFF_CAP_SECONDS."""
    return min(2**attempt, _BACKOFF_CAP_SECONDS)


def _make_session_factory() -> async_sessionmaker:
    """Create a new async session factory using the configured database URL."""
    engine = create_async_engine(settings.database_url, echo=False, future=True)
    return async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)


async def send_otp_email(to_email: str, meeting_title: str, code: str, db: AsyncSession) -> None:
    """
    Send an OTP verification email to the given address.
    Reads SMTP settings from the DB via smtp_config_service.
    Raises SmtpNotConfiguredError if SMTP is not configured.
    Respects settings.email_override: if set, all emails go to the override address
    and the original recipient is preserved in X-Original-To header.
    """
    smtp_config = await get_smtp_config(db)
    if not smtp_config.smtp_host or not smtp_config.smtp_username or not smtp_config.smtp_from_email or smtp_config.smtp_password_enc is None:
        raise SmtpNotConfiguredError(
            "SMTP not configured — configure mail server in admin settings"
        )
    smtp_password = get_decrypted_password(smtp_config)

    env = _get_jinja_env()
    template = env.get_template("otp_email.html")
    html_body = template.render(meeting_title=meeting_title, code=code)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Your AGM Voting Code — {meeting_title}"
    msg["From"] = smtp_config.smtp_from_email
    to_addr = settings.email_override if settings.email_override else to_email
    msg["To"] = to_addr
    if settings.email_override:
        msg["X-Original-To"] = to_email
    msg.attach(MIMEText(html_body, "html"))

    await aiosmtplib.send(
        msg,
        hostname=smtp_config.smtp_host,
        port=smtp_config.smtp_port,
        username=smtp_config.smtp_username,
        password=smtp_password,
        start_tls=True,
    )

    logger.info("otp_email_sent", to=to_addr, meeting_title=meeting_title)


class EmailService:
    async def send_report(self, agm_id: uuid.UUID, db: AsyncSession) -> None:
        """
        Attempt to send the results report email for the given AGM.

        Fetches AGM data, renders HTML template, sends via Resend SDK,
        and updates the EmailDelivery record on success or failure.
        """
        log = logger.bind(agm_id=str(agm_id))

        # Fetch General Meeting detail (raises HTTPException with 404 if not found)
        detail = await get_general_meeting_detail(agm_id, db)

        building_name: str = detail["building_name"]
        agm_title: str = detail["title"]
        meeting_at: str = str(detail["meeting_at"])
        voting_closes_at: str = str(detail["voting_closes_at"])

        # Fetch manager email from the Building record
        meeting_result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == agm_id))
        meeting_obj = meeting_result.scalar_one_or_none()
        if meeting_obj is None:  # pragma: no cover — already caught above by get_general_meeting_detail
            raise ValueError(f"General Meeting {agm_id} not found")

        building_result = await db.execute(
            select(Building).where(Building.id == meeting_obj.building_id)
        )
        building = building_result.scalar_one_or_none()
        if building is None or not building.manager_email:
            log.error("building_missing_manager_email", building_id=str(meeting_obj.building_id))
            raise ValueError(
                f"Building for AGM {agm_id} has no manager_email configured"
            )

        manager_email: str = building.manager_email

        # Render template
        env = _get_jinja_env()
        template = env.get_template("report_email.html")
        html_body = template.render(
            building_name=building_name,
            meeting_title=agm_title,
            meeting_at=meeting_at,
            voting_closes_at=voting_closes_at,
            total_eligible_voters=detail["total_eligible_voters"],
            total_submitted=detail["total_submitted"],
            motions=detail["motions"],
        )

        # Load SMTP config from DB
        smtp_config = await get_smtp_config(db)
        if not smtp_config.smtp_host or not smtp_config.smtp_username or not smtp_config.smtp_from_email or smtp_config.smtp_password_enc is None:
            raise SmtpNotConfiguredError(
                "SMTP not configured — configure mail server in admin settings"
            )
        smtp_password = get_decrypted_password(smtp_config)

        # Send via SMTP (STARTTLS)
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"General Meeting Results Report: {agm_title}"
        msg["From"] = smtp_config.smtp_from_email
        to_addr = settings.email_override if settings.email_override else manager_email
        msg["To"] = to_addr
        if settings.email_override:
            msg["X-Original-To"] = manager_email
        msg.attach(MIMEText(html_body, "html"))

        log.info("email_send_started", agm_id=str(agm_id), to=to_addr)
        await aiosmtplib.send(
            msg,
            hostname=smtp_config.smtp_host,
            port=smtp_config.smtp_port,
            username=smtp_config.smtp_username,
            password=smtp_password,
            start_tls=True,
        )

        log.info("email_send_completed", agm_id=str(agm_id), to=to_addr, subject=f"General Meeting Results Report: {agm_title}")
        log.info("email_sent", to=to_addr, subject=f"General Meeting Results Report: {agm_title}")

    async def trigger_with_retry(self, agm_id: uuid.UUID) -> None:
        """
        Background task: attempt delivery with exponential backoff.
        Max 30 attempts. Delays: 2^attempt seconds, capped at 3600s.

        Each attempt uses a fresh DB session so it survives server restarts
        (state is always read from and written to the DB).

        A PostgreSQL advisory lock keyed on agm_id is held for the entire
        lifetime of this task. If another concurrent call (e.g. from a second
        concurrent Lambda cold-start or an HTTP retry) already holds the lock
        for this agm_id, this invocation exits immediately — preventing
        duplicate email sends.
        """
        session_factory = _make_session_factory()
        attempt_number = 0

        # Acquire a per-agm advisory lock that persists for the life of this task.
        # The lock session is kept open (and its transaction active) until we return
        # so the lock is held continuously even across the per-attempt sleep delays.
        # SQLAlchemy AsyncSession autobegins a transaction on the first execute, so
        # no explicit begin() call is needed — the transaction (and the xact lock)
        # remain active until the session context exits.
        async with session_factory() as lock_db:
            if not await _try_acquire_email_lock(lock_db, agm_id):
                logger.info(
                    "email_send_skipped_lock_held",
                    agm_id=str(agm_id),
                )
                return

            while True:
                attempt_number += 1

                async with session_factory() as db:
                    # Fetch current delivery record
                    result = await db.execute(
                        select(EmailDelivery).where(EmailDelivery.general_meeting_id == agm_id)
                    )
                    delivery = result.scalar_one_or_none()

                    if delivery is None:
                        logger.warning(
                            "email_delivery_record_not_found",
                            agm_id=str(agm_id),
                            attempt_number=attempt_number,
                        )
                        return

                    # Skip if already delivered (covers Lambda restart after send)
                    if delivery.status == EmailDeliveryStatus.delivered:
                        logger.info(
                            "email_already_delivered",
                            agm_id=str(agm_id),
                            attempt_number=attempt_number,
                        )
                        return

                    # Skip if max attempts reached
                    if delivery.total_attempts >= _MAX_ATTEMPTS:
                        logger.warning(
                            "email_max_attempts_reached",
                            agm_id=str(agm_id),
                            attempt_number=attempt_number,
                            total_attempts=delivery.total_attempts,
                        )
                        return

                    current_attempt = delivery.total_attempts + 1

                    try:
                        await self.send_report(agm_id, db)

                        # Success
                        delivery.status = EmailDeliveryStatus.delivered
                        delivery.total_attempts = current_attempt
                        delivery.last_error = None
                        delivery.next_retry_at = None
                        await db.commit()

                        logger.info(
                            "email_delivery_attempt",
                            agm_id=str(agm_id),
                            attempt_number=current_attempt,
                            status="delivered",
                            error=None,
                            next_retry_at=None,
                        )
                        return

                    except SmtpNotConfiguredError as exc:
                        # Non-retryable: SMTP is not configured — fail immediately
                        error_str = str(exc)
                        delivery.total_attempts = current_attempt
                        delivery.last_error = error_str
                        delivery.status = EmailDeliveryStatus.failed
                        delivery.next_retry_at = None
                        await db.commit()

                        logger.error(
                            "email_delivery_attempt",
                            agm_id=str(agm_id),
                            attempt_number=current_attempt,
                            status="failed",
                            error=error_str,
                            next_retry_at=None,
                        )
                        logger.error(
                            "email_delivery_failed",
                            agm_id=str(agm_id),
                            total_attempts=current_attempt,
                            last_error=error_str,
                        )
                        return

                    except Exception as exc:
                        error_str = str(exc)
                        delivery.total_attempts = current_attempt
                        delivery.last_error = error_str

                        if current_attempt >= _MAX_ATTEMPTS:
                            delivery.status = EmailDeliveryStatus.failed
                            delivery.next_retry_at = None
                            await db.commit()

                            logger.error(
                                "email_delivery_attempt",
                                agm_id=str(agm_id),
                                attempt_number=current_attempt,
                                status="failed",
                                error=error_str,
                                next_retry_at=None,
                            )
                            # Emit the structured alert event (US-OPS-05) with all
                            # fields needed for external alerting systems.
                            logger.error(
                                "email_delivery_failed",
                                agm_id=str(agm_id),
                                total_attempts=current_attempt,
                                last_error=error_str,
                            )
                            return
                        else:
                            delay = _backoff_seconds(current_attempt)
                            next_retry_at = datetime.now(UTC) + timedelta(seconds=delay)
                            delivery.next_retry_at = next_retry_at
                            # Keep status as pending while retrying
                            delivery.status = EmailDeliveryStatus.pending
                            await db.commit()

                            logger.warning(
                                "email_delivery_attempt",
                                agm_id=str(agm_id),
                                attempt_number=current_attempt,
                                status="pending",
                                error=error_str,
                                next_retry_at=next_retry_at.isoformat(),
                            )

                # Wait before next attempt
                delay = _backoff_seconds(attempt_number)
                await asyncio.sleep(delay)

    async def requeue_pending_on_startup(self, db: AsyncSession) -> None:
        """
        Called on server startup. Finds all EmailDelivery records with
        status='pending' and total_attempts < 30, and re-launches
        trigger_with_retry tasks.

        Tasks are collected and awaited via asyncio.gather so they are not
        silently dropped if the Lambda exits before they complete (RR3-19).
        """
        result = await db.execute(
            select(EmailDelivery).where(
                EmailDelivery.status == EmailDeliveryStatus.pending,
                EmailDelivery.total_attempts < _MAX_ATTEMPTS,
            )
        )
        pending_deliveries = list(result.scalars().all())

        tasks = []
        for delivery in pending_deliveries:
            logger.info(
                "requeueing_pending_email",
                general_meeting_id=str(delivery.general_meeting_id),
                total_attempts=delivery.total_attempts,
            )
            tasks.append(_send_with_limit(self.trigger_with_retry(delivery.general_meeting_id)))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
