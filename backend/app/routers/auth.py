"""
Authentication endpoints:
  POST /api/auth/request-otp  — send a one-time code to the voter's email
  POST /api/auth/verify       — validate the OTP and create a session
  GET  /api/test/latest-otp   — test-only: retrieve latest OTP for (email, meeting_id)
"""
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.logging_config import get_logger
from app.models.auth_otp import AuthOtp
from app.models.building import Building
from app.models.general_meeting import GeneralMeeting, get_effective_status
from app.models.ballot_submission import BallotSubmission
from app.models.lot_owner import LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.lot_proxy import LotProxy
from app.schemas.auth import (
    AuthVerifyRequest,
    AuthVerifyResponse,
    LotInfo,
    OtpRequestBody,
    OtpRequestResponse,
)
from app.services.auth_service import create_session
from app.services.email_service import send_otp_email

logger = get_logger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory rate limiter: (email, meeting_id) → last request timestamp
# ---------------------------------------------------------------------------
_otp_rate_limit: dict[tuple, datetime] = {}

# ---------------------------------------------------------------------------
# OTP alphabet — excludes visually ambiguous characters O, 0, I, 1
# ---------------------------------------------------------------------------
_OTP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_otp_code() -> str:
    return "".join(secrets.choice(_OTP_ALPHABET) for _ in range(8))


@router.post("/auth/request-otp", response_model=OtpRequestResponse)
async def request_otp(
    body: OtpRequestBody,
    db: AsyncSession = Depends(get_db),
) -> OtpRequestResponse:
    """
    Send a one-time verification code to the voter's email.
    Always returns 200 {"sent": true} to prevent email enumeration.
    """
    # 1. Fetch the GeneralMeeting
    meeting_result = await db.execute(
        select(GeneralMeeting).where(GeneralMeeting.id == body.general_meeting_id)
    )
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found")

    # 2. Rate limit: 60 seconds between requests for same (email, meeting_id).
    #    Disabled in testing_mode so E2E tests can re-request OTPs immediately
    #    after setup (beforeAll) without hitting the 429 rate limit.
    rate_key = (body.email, body.general_meeting_id)
    if not settings.testing_mode:
        last_sent = _otp_rate_limit.get(rate_key)
        if last_sent is not None:
            elapsed = (datetime.now(UTC) - last_sent).total_seconds()
            if elapsed < 60:
                raise HTTPException(
                    status_code=429,
                    detail="Please wait before requesting another code",
                )

    # 3. Check if email is known in this building (enumeration-safe: still return 200 if not found)
    emails_result = await db.execute(
        select(LotOwnerEmail)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email == body.email,
            LotOwner.building_id == meeting.building_id,
        )
    )
    email_records = list(emails_result.scalars().all())

    proxy_result = await db.execute(
        select(LotProxy)
        .join(LotOwner, LotProxy.lot_owner_id == LotOwner.id)
        .where(
            LotProxy.proxy_email == body.email,
            LotOwner.building_id == meeting.building_id,
        )
    )
    proxy_records = list(proxy_result.scalars().all())

    email_known = bool(email_records or proxy_records)

    if email_known:
        # 4. Delete existing OTPs for this (email, meeting_id) pair (lazy cleanup)
        await db.execute(
            delete(AuthOtp).where(
                AuthOtp.email == body.email,
                AuthOtp.meeting_id == body.general_meeting_id,
            )
        )

        # 5. Generate and insert new OTP
        code = _generate_otp_code()
        expires_at = datetime.now(UTC) + timedelta(minutes=5)
        otp = AuthOtp(
            email=body.email,
            meeting_id=body.general_meeting_id,
            code=code,
            expires_at=expires_at,
        )
        db.add(otp)
        await db.commit()

        # 6. Update rate limit tracker
        _otp_rate_limit[rate_key] = datetime.now(UTC)

        # 7. Send the OTP email
        try:
            await send_otp_email(
                to_email=body.email,
                meeting_title=meeting.title,
                code=code,
            )
        except Exception as exc:
            logger.error("otp_email_send_failed", email=body.email, error=str(exc))
            raise HTTPException(status_code=500, detail="Failed to send verification code")
    else:
        # Still update the rate limit so attackers can't use "no rate limit" as
        # a signal that the email was not found.
        _otp_rate_limit[rate_key] = datetime.now(UTC)

    return OtpRequestResponse(sent=True)


@router.post("/auth/verify", response_model=AuthVerifyResponse)
async def verify_auth(
    request: AuthVerifyRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthVerifyResponse:
    """
    Authenticate a voter by email + OTP code + general_meeting_id.
    Validates the OTP first, then derives building_id from the GeneralMeeting record.
    Looks up all lot owners for this building that have the given email (direct ownership)
    AND lots where this email is a nominated proxy.
    Returns the merged list of lots along with their submission status.
    """
    # 1. Fetch the GeneralMeeting to derive building_id
    meeting_result = await db.execute(
        select(GeneralMeeting).where(
            GeneralMeeting.id == request.general_meeting_id,
        )
    )
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found")

    # 2. Validate OTP — find most recent unused unexpired OTP for (email, meeting_id)
    now = datetime.now(UTC)
    otp_result = await db.execute(
        select(AuthOtp)
        .where(
            AuthOtp.email == request.email,
            AuthOtp.meeting_id == request.general_meeting_id,
            AuthOtp.used == False,  # noqa: E712
            AuthOtp.expires_at > now,
        )
        .order_by(AuthOtp.created_at.desc())
        .limit(1)
    )
    otp = otp_result.scalar_one_or_none()

    if otp is None or otp.code != request.code:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired verification code",
        )

    # 3. Mark OTP as used (flush, commit at end of handler)
    otp.used = True
    await db.flush()

    building_id = meeting.building_id

    # 4. Find all LotOwnerEmail records matching email for this building (direct owners)
    emails_result = await db.execute(
        select(LotOwnerEmail)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email == request.email,
            LotOwner.building_id == building_id,
        )
    )
    email_records = list(emails_result.scalars().all())
    direct_lot_owner_ids: set[uuid.UUID] = {er.lot_owner_id for er in email_records}

    # 5. Find all LotProxy records where proxy_email matches and lot is in this building
    proxy_result = await db.execute(
        select(LotProxy)
        .join(LotOwner, LotProxy.lot_owner_id == LotOwner.id)
        .where(
            LotProxy.proxy_email == request.email,
            LotOwner.building_id == building_id,
        )
    )
    proxy_records = list(proxy_result.scalars().all())
    proxy_lot_owner_ids: set[uuid.UUID] = {pr.lot_owner_id for pr in proxy_records}

    # 6. Merge: union of direct and proxy lots
    all_lot_owner_ids = direct_lot_owner_ids | proxy_lot_owner_ids

    if not all_lot_owner_ids:
        raise HTTPException(
            status_code=401,
            detail="Email address not found for this building",
        )

    # 7. Fetch the Building to get building_name
    building_result = await db.execute(
        select(Building).where(Building.id == building_id)
    )
    building = building_result.scalar_one()

    # 8. Fetch all relevant LotOwner records
    lots_result = await db.execute(
        select(LotOwner).where(LotOwner.id.in_(all_lot_owner_ids))
    )
    lot_owners = {lo.id: lo for lo in lots_result.scalars().all()}

    # 9. Check submissions per lot owner
    submissions_result = await db.execute(
        select(BallotSubmission).where(
            BallotSubmission.general_meeting_id == request.general_meeting_id,
            BallotSubmission.lot_owner_id.in_(all_lot_owner_ids),
        )
    )
    submitted_lot_ids: set[uuid.UUID] = {s.lot_owner_id for s in submissions_result.scalars().all()}

    lots = []
    for lot_owner_id in all_lot_owner_ids:
        lo = lot_owners.get(lot_owner_id)
        if lo is None:  # pragma: no cover  # FK constraint guarantees lot_owner always exists
            continue
        # Direct owner takes precedence: is_proxy=False if voter is a direct owner of this lot
        is_proxy = lot_owner_id not in direct_lot_owner_ids
        fp = lo.financial_position
        lots.append(LotInfo(
            lot_owner_id=lo.id,
            lot_number=lo.lot_number,
            financial_position=fp.value if hasattr(fp, "value") else fp,
            already_submitted=lo.id in submitted_lot_ids,
            is_proxy=is_proxy,
        ))

    # Sort by lot_number for consistent ordering
    lots.sort(key=lambda l: l.lot_number)

    # 10. Create session
    token = await create_session(
        db=db,
        voter_email=request.email,
        building_id=building_id,
        general_meeting_id=request.general_meeting_id,
    )
    await db.commit()

    response.set_cookie(
        key="meeting_session",
        value=token,
        httponly=True,
        samesite="lax",
    )

    return AuthVerifyResponse(
        lots=lots,
        voter_email=request.email,
        # Use effective status so past-voting_closes_at meetings report as closed
        # even before the auto-close job has run (US-CD03).
        agm_status=get_effective_status(meeting).value,
        building_name=building.name,
        meeting_title=meeting.title,
    )


@router.get("/test/latest-otp")
async def get_latest_otp(
    email: str,
    meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Test-only endpoint: returns the most recent unused OTP for (email, meeting_id).
    Only available when settings.testing_mode is True.
    """
    if not settings.testing_mode:
        raise HTTPException(status_code=404)

    result = await db.execute(
        select(AuthOtp)
        .where(
            AuthOtp.email == email,
            AuthOtp.meeting_id == meeting_id,
            AuthOtp.used == False,  # noqa: E712
        )
        .order_by(AuthOtp.created_at.desc())
        .limit(1)
    )
    otp = result.scalar_one_or_none()
    if not otp:
        raise HTTPException(status_code=404, detail="No OTP found")
    return {"code": otp.code, "expires_at": otp.expires_at.isoformat()}
