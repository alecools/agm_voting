"""
Authentication endpoints:
  POST /api/auth/request-otp  — send a one-time code to the voter's email
  POST /api/auth/verify       — validate the OTP and create a session
  GET  /api/test/latest-otp   — test-only: retrieve latest OTP for (email, meeting_id)
"""
import asyncio
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import AsyncSessionLocal, get_db
from app.logging_config import get_logger
from app.models.auth_otp import AuthOtp
from app.models.building import Building
from app.models.general_meeting import GeneralMeeting, get_effective_status
from app.models.lot_owner import LotOwner
from app.models.lot_owner_email import LotOwnerEmail
from app.models.lot_proxy import LotProxy
from app.models.motion import Motion
from app.models.otp_rate_limit import OTPRateLimit
from app.models.session_record import SessionRecord
from app.models.vote import Vote, VoteStatus
from app.schemas.auth import (
    AuthVerifyRequest,
    AuthVerifyResponse,
    LotInfo,
    OtpRequestBody,
    OtpRequestResponse,
    SessionRestoreRequest,
)
from app.services.auth_service import (
    _TOKEN_MAX_AGE_SECONDS,
    _load_direct_lot_owner_ids,
    _load_proxy_lot_owner_ids,
    _unsign_token,
    create_session,
    extend_session,
)
from app.services.email_service import send_otp_email

logger = get_logger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Rate-limit constants
# ---------------------------------------------------------------------------
_OTP_RATE_LIMIT_WINDOW_SECONDS = 60
_OTP_RATE_LIMIT_MAX_ATTEMPTS = 1  # one successful request per window

# ---------------------------------------------------------------------------
# OTP alphabet — excludes visually ambiguous characters O, 0, I, 1
# ---------------------------------------------------------------------------
_OTP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_otp_code() -> str:
    return "".join(secrets.choice(_OTP_ALPHABET) for _ in range(8))


async def _resolve_voter_state(
    db: AsyncSession,
    voter_email: str,
    general_meeting_id: uuid.UUID,
    building_id: uuid.UUID,
) -> dict:
    """Shared lot-lookup helper used by both verify_auth and restore_session.

    Looks up direct lot owners and proxy lots for the given voter email within
    the building, fetches visible motions, and computes per-lot already_submitted
    and voted_motion_ids flags.

    Returns a dict with keys:
      - lots: list[LotInfo]
      - visible_motions: list[Motion]
      - unvoted_visible_count: int
    """
    # Fire direct-owner and proxy-lot lookups concurrently.
    # Each helper opens its own AsyncSession so they can run in parallel without
    # sharing a connection — a single AsyncSession must not be used across
    # concurrent coroutines (SQLAlchemy asyncio safety requirement).
    direct_lot_owner_ids, proxy_lot_owner_ids = await asyncio.gather(
        _load_direct_lot_owner_ids(voter_email, building_id),
        _load_proxy_lot_owner_ids(voter_email, building_id),
    )

    # Merge: union of direct and proxy lots
    all_lot_owner_ids = direct_lot_owner_ids | proxy_lot_owner_ids

    # Fetch all relevant LotOwner records
    lots_result = await db.execute(
        select(LotOwner).where(LotOwner.id.in_(all_lot_owner_ids))
    )
    lot_owners = {lo.id: lo for lo in lots_result.scalars().all()}

    # Fetch all currently visible motions for this meeting.
    visible_motions_result = await db.execute(
        select(Motion).where(
            Motion.general_meeting_id == general_meeting_id,
            Motion.is_visible == True,  # noqa: E712
        )
    )
    visible_motions = list(visible_motions_result.scalars().all())
    visible_motion_ids: set[uuid.UUID] = {m.id for m in visible_motions}

    # For each lot, determine the set of visible motion IDs that already have a
    # submitted Vote row.
    voted_by_lot_result = await db.execute(
        select(Vote.lot_owner_id, Vote.motion_id).where(
            Vote.general_meeting_id == general_meeting_id,
            Vote.lot_owner_id.in_(all_lot_owner_ids),
            Vote.status == VoteStatus.submitted,
        )
    )
    voted_motion_ids_by_lot: dict[uuid.UUID, set[uuid.UUID]] = {}
    for lot_owner_id, motion_id in voted_by_lot_result.all():
        voted_motion_ids_by_lot.setdefault(lot_owner_id, set()).add(motion_id)

    lots = []
    for lot_owner_id in all_lot_owner_ids:
        lo = lot_owners.get(lot_owner_id)
        if lo is None:  # pragma: no cover  # FK constraint guarantees lot_owner always exists
            continue
        is_proxy = lot_owner_id not in direct_lot_owner_ids
        fp = lo.financial_position
        voted_for_this_lot = voted_motion_ids_by_lot.get(lot_owner_id, set())
        already_submitted = (
            len(visible_motion_ids) > 0
            and visible_motion_ids.issubset(voted_for_this_lot)
        )
        lots.append(LotInfo(
            lot_owner_id=lo.id,
            lot_number=lo.lot_number,
            financial_position=fp.value if hasattr(fp, "value") else fp,
            already_submitted=already_submitted,
            is_proxy=is_proxy,
            voted_motion_ids=list(voted_for_this_lot),
        ))

    lots.sort(key=lambda l: l.lot_number)

    any_lot_not_submitted = any(not l.already_submitted for l in lots)
    unvoted_visible_count = len(visible_motions) if any_lot_not_submitted else 0

    return {
        "lots": lots,
        "visible_motions": visible_motions,
        "unvoted_visible_count": unvoted_visible_count,
    }


async def _upsert_rate_limit(
    db: AsyncSession,
    email: str,
    building_id: uuid.UUID,
    now: datetime,
) -> None:
    """Insert or update the OTPRateLimit row for (email, building_id).

    Resets the window on each call — caller is responsible for checking the
    limit BEFORE calling this function.
    """
    rl_result = await db.execute(
        select(OTPRateLimit).where(
            OTPRateLimit.email == email,
            OTPRateLimit.building_id == building_id,
        )
    )
    rl_record = rl_result.scalar_one_or_none()
    if rl_record is None:
        db.add(OTPRateLimit(
            email=email,
            building_id=building_id,
            attempt_count=1,
            first_attempt_at=now,
            last_attempt_at=now,
        ))
    else:
        rl_record.attempt_count += 1
        rl_record.last_attempt_at = now
    await db.flush()


async def _cleanup_expired_otps() -> None:
    """Delete expired OTP records — runs as a fire-and-forget background task."""
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                delete(AuthOtp).where(AuthOtp.expires_at < datetime.now(UTC))
            )
            await session.commit()
    except Exception:  # pragma: no cover
        pass  # Background cleanup — never let failures surface to the caller


async def _cleanup_expired_sessions() -> None:
    """Delete expired session records — runs as a fire-and-forget background task."""
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                delete(SessionRecord).where(SessionRecord.expires_at < datetime.now(UTC))
            )
            await session.commit()
    except Exception:  # pragma: no cover
        pass  # Background cleanup — never let failures surface to the caller


@router.post("/auth/request-otp", response_model=OtpRequestResponse)
async def request_otp(
    body: OtpRequestBody,
    db: AsyncSession = Depends(get_db),
) -> OtpRequestResponse:
    """
    Send a one-time verification code to the voter's email.
    Always returns 200 {"sent": true} to prevent email enumeration.
    """
    # Fire-and-forget cleanup of expired OTPs — doesn't block the request.
    asyncio.create_task(_cleanup_expired_otps())

    # Normalise email to lowercase for case-insensitive matching
    body = body.model_copy(update={"email": body.email.strip().lower()})

    # 1. Fetch the GeneralMeeting
    meeting_result = await db.execute(
        select(GeneralMeeting).where(GeneralMeeting.id == body.general_meeting_id)
    )
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found")

    # 2. Rate limit: 60 seconds between requests for same (email, building_id).
    #    Stored in the DB so the limit survives process restarts and applies
    #    across all Lambda instances.
    #    Disabled in testing_mode so E2E tests can re-request OTPs immediately
    #    after setup (beforeAll) without hitting the 429 rate limit.
    if not settings.testing_mode:
        now_for_rate = datetime.now(UTC)
        rl_result = await db.execute(
            select(OTPRateLimit).where(
                OTPRateLimit.email == body.email,
                OTPRateLimit.building_id == meeting.building_id,
            )
        )
        rl_record = rl_result.scalar_one_or_none()
        if rl_record is not None:
            # Use first_attempt_at for a fixed window: the window starts when the
            # first request is made and cannot be reset by subsequent requests.
            # Using last_attempt_at would let an attacker keep the window open
            # indefinitely by making a request just before each window expires.
            elapsed = (now_for_rate - rl_record.first_attempt_at.replace(tzinfo=UTC)).total_seconds()
            if elapsed < _OTP_RATE_LIMIT_WINDOW_SECONDS:
                logger.warning(
                    "otp_rate_limit_triggered",
                    email=body.email,
                    agm_id=str(body.general_meeting_id),
                )
                raise HTTPException(
                    status_code=429,
                    detail="Please wait before requesting another code",
                )

    # 3. Check if email is known in this building (enumeration-safe: still return 200 if not found)
    emails_result = await db.execute(
        select(LotOwnerEmail)
        .join(LotOwner, LotOwnerEmail.lot_owner_id == LotOwner.id)
        .where(
            LotOwnerEmail.email.isnot(None),
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

        # 6. Upsert DB rate-limit record (reset window on each successful OTP issue)
        now_rl = datetime.now(UTC)
        if not settings.testing_mode:
            await _upsert_rate_limit(db, body.email, meeting.building_id, now_rl)

        # 7. Send the OTP email (skipped when skip_email=True in testing_mode only).
        # skip_email is silently ignored in non-testing environments (RR5-03).
        skip_email_effective = body.skip_email and settings.testing_mode
        if not skip_email_effective:
            try:
                await send_otp_email(
                    to_email=body.email,
                    meeting_title=meeting.title,
                    code=code,
                    db=db,
                )
            except Exception as exc:
                # Log the SMTP failure but still return 200 — the OTP is already stored
                # in the DB, so the voter can still authenticate (or retry sending).
                # A 500 here would expose SMTP misconfiguration and break the auth flow
                # even though the OTP record was successfully created.
                logger.error("otp_email_send_failed", email=body.email, error=str(exc))
    else:
        # Still update the rate limit so attackers can't use "no rate limit" as
        # a signal that the email was not found.
        if not settings.testing_mode:
            now_rl = datetime.now(UTC)
            await _upsert_rate_limit(db, body.email, meeting.building_id, now_rl)

    return OtpRequestResponse(sent=True)


@router.post("/auth/logout")
async def logout(
    response: Response,
    agm_session: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Clear the voter session cookie and delete the server-side SessionRecord row.

    The frontend calls this to end a session. Logout is idempotent — an expired,
    invalid, or absent cookie still results in a 200 with the cookie cleared.
    """
    if agm_session:
        try:
            raw_token = _unsign_token(agm_session)
            await db.execute(
                delete(SessionRecord).where(
                    SessionRecord.session_token == raw_token
                )
            )
            await db.commit()
        except HTTPException:
            pass  # Expired/invalid signature — no DB row to delete; still clear cookie
    response.delete_cookie(key="agm_session", path="/api")
    return {"ok": True}


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
    # Normalise email to lowercase for case-insensitive matching
    request = request.model_copy(update={"email": request.email.strip().lower()})

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

    if otp is None:
        # Perform a timing-safe comparison against a dummy value so that
        # "no OTP row found" and "OTP found but code wrong" take the same
        # wall-clock time — eliminating a timing oracle that could reveal
        # whether a submitted OTP code exists in the DB (RR3-16).
        hmac.compare_digest(request.code, request.code)
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired verification code",
        )
    if not hmac.compare_digest(otp.code, request.code):
        logger.warning(
            "otp_verify_failed",
            email=request.email,
            agm_id=str(request.general_meeting_id),
            reason="code_mismatch",
        )
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired verification code",
        )

    # 3. Mark OTP as used (flush, commit at end of handler)
    otp.used = True
    await db.flush()

    building_id = meeting.building_id

    # 4. Resolve lots, visible motions, and already_submitted flags via shared helper
    voter_state = await _resolve_voter_state(
        db=db,
        voter_email=request.email,
        general_meeting_id=request.general_meeting_id,
        building_id=building_id,
    )
    lots = voter_state["lots"]

    if not lots:
        raise HTTPException(
            status_code=401,
            detail="Email address not found for this building",
        )

    unvoted_visible_count = voter_state["unvoted_visible_count"]

    # 5. Fetch the Building to get building_name
    building_result = await db.execute(
        select(Building).where(Building.id == building_id)
    )
    building = building_result.scalar_one()

    # 6. Create session
    token = await create_session(
        db=db,
        voter_email=request.email,
        building_id=building_id,
        general_meeting_id=request.general_meeting_id,
    )
    await db.commit()

    response.set_cookie(
        key="agm_session",
        value=token,
        httponly=True,
        secure=not settings.testing_mode,
        # SameSite=Lax (not Strict): the voter's first request after clicking the OTP email
        # link is a top-level cross-site navigation; Strict would drop the cookie on that
        # request, forcing a second round-trip.  Lax is safe here because no state-changing
        # GET endpoints exist and all POST endpoints require a valid session token — so
        # CSRF via cross-site form submission cannot succeed (security deviation: SD-001).
        samesite="lax",
        max_age=_TOKEN_MAX_AGE_SECONDS,  # matches SESSION_DURATION (RR3-36)
        path="/api",
    )

    logger.info(
        "auth_login_success",
        email=request.email,
        agm_id=str(request.general_meeting_id),
        lot_count=len(lots),
    )
    return AuthVerifyResponse(
        lots=lots,
        voter_email=request.email,
        # Use effective status so past-voting_closes_at meetings report as closed
        # even before the auto-close job has run (US-CD03).
        agm_status=get_effective_status(meeting).value,
        building_name=building.name,
        meeting_title=meeting.title,
        unvoted_visible_count=unvoted_visible_count,
        # Deprecated: token is now delivered via HttpOnly cookie only. Field retained for backward compat. (RR5-02)
        session_token="",
    )


@router.post("/auth/session", response_model=AuthVerifyResponse)
async def restore_session(
    request: SessionRestoreRequest,
    response: Response,
    agm_session: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> AuthVerifyResponse:
    """
    Restore a voter session.  Accepts the session token via:
      1. The agm_session HttpOnly cookie (preferred — set by POST /api/auth/verify)
      2. The session_token field in the JSON request body (backward compatibility)

    Validates the token, checks that the AGM is still open, and returns the same
    AuthVerifyResponse shape as POST /api/auth/verify so the frontend can skip the OTP flow.

    Returns 401 if the token is invalid, expired, or the AGM is closed.
    """
    # Fire-and-forget cleanup of expired sessions — doesn't block the request.
    asyncio.create_task(_cleanup_expired_sessions())

    # Resolve the token: cookie takes priority over request body
    token_to_use = agm_session or request.session_token

    if not token_to_use:
        raise HTTPException(status_code=401, detail="Session expired or invalid")

    # Unsign the token before DB lookup (token in cookie/body is signed;
    # DB stores the raw token). _unsign_token raises HTTPException 401 on failure.
    raw_token = _unsign_token(token_to_use)

    # 1. Look up session by token + meeting_id + expiry using get_session logic directly.
    #    get_session() requires Cookie/Header params so we call the DB directly here.
    now = datetime.now(UTC)
    session_result = await db.execute(
        select(SessionRecord).where(
            SessionRecord.session_token == raw_token,
            SessionRecord.general_meeting_id == request.general_meeting_id,
            SessionRecord.expires_at > now,
        )
    )
    session_record = session_result.scalar_one_or_none()
    if session_record is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")

    # 2. Load the GeneralMeeting
    meeting_result = await db.execute(
        select(GeneralMeeting).where(GeneralMeeting.id == request.general_meeting_id)
    )
    meeting = meeting_result.scalar_one_or_none()
    if meeting is None:  # pragma: no cover  # SessionRecord has ON DELETE CASCADE FK to GeneralMeeting; meeting cannot be deleted while session exists
        raise HTTPException(status_code=404, detail="General Meeting not found")

    # 3. Reject closed meetings — forces frontend through normal OTP flow which
    #    handles closed-meeting routing via agm_status: "closed".
    if get_effective_status(meeting).value == "closed":
        raise HTTPException(status_code=401, detail="Session expired — meeting is closed")

    voter_email = session_record.voter_email
    building_id = meeting.building_id

    # 4. Run lot-lookup via shared helper (same logic as verify_auth)
    voter_state = await _resolve_voter_state(
        db=db,
        voter_email=voter_email,
        general_meeting_id=request.general_meeting_id,
        building_id=building_id,
    )
    lots = voter_state["lots"]
    unvoted_visible_count = voter_state["unvoted_visible_count"]

    # 5. Fetch Building for name
    building_result = await db.execute(
        select(Building).where(Building.id == building_id)
    )
    building = building_result.scalar_one()

    # 6. Extend the existing session (update expires_at) instead of inserting a new row.
    #    This avoids session row proliferation — each voter has at most one active
    #    SessionRecord at any time.  The raw token is reused; only expires_at is updated.
    new_token = await extend_session(db=db, session_record=session_record)
    await db.commit()

    response.set_cookie(
        key="agm_session",
        value=new_token,
        httponly=True,
        secure=not settings.testing_mode,
        # SameSite=Lax (not Strict): the voter's first request after clicking the OTP email
        # link is a top-level cross-site navigation; Strict would drop the cookie on that
        # request, forcing a second round-trip.  Lax is safe here because no state-changing
        # GET endpoints exist and all POST endpoints require a valid session token — so
        # CSRF via cross-site form submission cannot succeed (security deviation: SD-001).
        samesite="lax",
        max_age=_TOKEN_MAX_AGE_SECONDS,  # matches SESSION_DURATION (RR3-36)
        path="/api",
    )

    return AuthVerifyResponse(
        lots=lots,
        voter_email=voter_email,
        agm_status=get_effective_status(meeting).value,
        building_name=building.name,
        meeting_title=meeting.title,
        unvoted_visible_count=unvoted_visible_count,
        # Deprecated: token is now delivered via HttpOnly cookie only. Field retained for backward compat. (RR5-02)
        session_token="",
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
