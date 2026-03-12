"""
Email service for AGM results report delivery via Resend.

Provides:
- send_report(): render the HTML template and send via Resend
- trigger_with_retry(): background task with exponential backoff, up to 30 attempts
- requeue_pending_on_startup(): re-launch retry tasks for pending deliveries on startup
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import resend
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.logging_config import get_logger
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

_TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
_MAX_ATTEMPTS = 30
_BACKOFF_CAP_SECONDS = 3600


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
            agm_title=agm_title,
            meeting_at=meeting_at,
            voting_closes_at=voting_closes_at,
            total_eligible_voters=detail["total_eligible_voters"],
            total_submitted=detail["total_submitted"],
            motions=detail["motions"],
        )

        # Send via Resend
        resend.api_key = settings.resend_api_key
        params: resend.Emails.SendParams = {
            "from": settings.resend_from_email,
            "to": [manager_email],
            "subject": f"General Meeting Results Report: {agm_title}",
            "html": html_body,
        }
        resend.Emails.send(params)

        log.info("email_sent", to=manager_email, subject=f"General Meeting Results Report: {agm_title}")

    async def trigger_with_retry(self, agm_id: uuid.UUID) -> None:
        """
        Background task: attempt delivery with exponential backoff.
        Max 30 attempts. Delays: 2^attempt seconds, capped at 3600s.

        Each attempt uses a fresh DB session so it survives server restarts
        (state is always read from and written to the DB).
        """
        session_factory = _make_session_factory()
        attempt_number = 0

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

                # Skip if already delivered
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
        trigger_with_retry as asyncio background tasks.
        """
        result = await db.execute(
            select(EmailDelivery).where(
                EmailDelivery.status == EmailDeliveryStatus.pending,
                EmailDelivery.total_attempts < _MAX_ATTEMPTS,
            )
        )
        pending_deliveries = list(result.scalars().all())

        for delivery in pending_deliveries:
            logger.info(
                "requeueing_pending_email",
                general_meeting_id=str(delivery.general_meeting_id),
                total_attempts=delivery.total_attempts,
            )
            asyncio.create_task(self.trigger_with_retry(delivery.general_meeting_id))
