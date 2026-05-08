"""
Session creation and validation logic for lot owner authentication.
"""
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Cookie, Header, HTTPException
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import AsyncSessionLocal
from app.logging_config import get_logger
from app.models.auth_otp import AuthOtp
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.lot_proxy import LotProxy
from app.models.otp_rate_limit import OTPRateLimit
from app.models.person import Person
from app.models.session_record import SessionRecord

logger = get_logger(__name__)

SESSION_DURATION_HOURS = 24  # kept for backward compatibility
SESSION_DURATION = timedelta(hours=2)

# Maximum age for a signed session token — matches SESSION_DURATION exactly
# so that a token cannot outlive the DB session record (RR3-36).
_TOKEN_MAX_AGE_SECONDS = int(SESSION_DURATION.total_seconds())  # 7200


def _get_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.session_secret)


def _sign_token(raw_token: str) -> str:
    """Return an itsdangerous-signed representation of raw_token."""
    s = _get_serializer()
    return s.dumps({"token": raw_token})


def _unsign_token(signed_token: str) -> str:
    """Verify and extract the raw token from a signed value.

    Raises HTTPException 401 if the signature is invalid or expired.
    """
    s = _get_serializer()
    try:
        payload = s.loads(signed_token, max_age=_TOKEN_MAX_AGE_SECONDS)
        return payload["token"]
    except SignatureExpired:
        logger.warning("session_token_invalid", reason="signature_expired")
        raise HTTPException(
            status_code=401,
            detail="Session expired. Please authenticate again.",
        )
    except BadSignature:
        logger.warning("session_token_invalid", reason="bad_signature")
        raise HTTPException(
            status_code=401,
            detail="Session expired. Please authenticate again.",
        )
    except Exception:
        logger.warning("session_token_invalid", reason="unknown_error")
        raise HTTPException(
            status_code=401,
            detail="Session expired. Please authenticate again.",
        )


async def _load_direct_lot_owner_ids(
    voter_email: str, building_id: uuid.UUID
) -> set[uuid.UUID]:
    """Load lot IDs for direct lot owners matching voter_email within building_id.

    Opens its own AsyncSession so it can be run concurrently via asyncio.gather
    without sharing a session with another coroutine.
    """
    async with AsyncSessionLocal() as s:
        r = await s.execute(
            select(lot_persons.c.lot_id)
            .join(Person, Person.id == lot_persons.c.person_id)
            .join(Lot, Lot.id == lot_persons.c.lot_id)
            .where(
                Person.email.isnot(None),
                Person.email == voter_email,
                Lot.building_id == building_id,
            )
        )
        return {row[0] for row in r.all()}


async def _load_proxy_lot_owner_ids(
    voter_email: str, building_id: uuid.UUID
) -> set[uuid.UUID]:
    """Load lot IDs for proxy lots where proxy person email matches within building_id.

    Opens its own AsyncSession so it can be run concurrently via asyncio.gather
    without sharing a session with another coroutine.
    """
    async with AsyncSessionLocal() as s:
        r = await s.execute(
            select(LotProxy.lot_id)
            .join(Person, Person.id == LotProxy.person_id)
            .join(Lot, Lot.id == LotProxy.lot_id)
            .where(
                Person.email == voter_email,
                Lot.building_id == building_id,
            )
        )
        return {row[0] for row in r.all()}



def mask_phone_hint(phone_number: str) -> str:
    """Return a masked phone hint revealing only the last 4 digits.

    e.g. "+61433590018" -> "•••• •••• 0018"
    """
    digits = "".join(c for c in phone_number if c.isdigit())
    last4 = digits[-4:] if len(digits) >= 4 else digits
    return "•••• •••• " + last4


async def upsert_rate_limit(
    db: AsyncSession,
    email: str,
    building_id: uuid.UUID,
    now: datetime,
) -> None:
    """Insert or update the OTPRateLimit row for (email, building_id).

    Resets the window on each call — caller is responsible for checking the
    limit BEFORE calling this function.
    """
    from sqlalchemy import select as _select
    rl_result = await db.execute(
        _select(OTPRateLimit).where(
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



async def resolve_voter_state(
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
    import asyncio as _asyncio
    from sqlalchemy import select as _select
    from app.models.lot import Lot as _Lot
    from app.models.motion import Motion as _Motion
    from app.models.vote import Vote as _Vote, VoteStatus as _VoteStatus
    from app.schemas.auth import LotInfo as _LotInfo

    # Fire direct-owner and proxy-lot lookups concurrently.
    # Each helper opens its own AsyncSession so they can run in parallel without
    # sharing a connection — a single AsyncSession must not be used across
    # concurrent coroutines (SQLAlchemy asyncio safety requirement).
    direct_lot_owner_ids, proxy_lot_owner_ids = await _asyncio.gather(
        _load_direct_lot_owner_ids(voter_email, building_id),
        _load_proxy_lot_owner_ids(voter_email, building_id),
    )

    # Merge: union of direct and proxy lots
    all_lot_owner_ids = direct_lot_owner_ids | proxy_lot_owner_ids

    # Fetch all relevant Lot records
    lots_result = await db.execute(
        _select(_Lot).where(_Lot.id.in_(all_lot_owner_ids))
    )
    lot_owners = {lo.id: lo for lo in lots_result.scalars().all()}

    # Fetch all currently visible motions for this meeting.
    visible_motions_result = await db.execute(
        _select(_Motion).where(
            _Motion.general_meeting_id == general_meeting_id,
            _Motion.is_visible == True,  # noqa: E712
        )
    )
    visible_motions = list(visible_motions_result.scalars().all())
    visible_motion_ids: set[uuid.UUID] = {m.id for m in visible_motions}

    # For each lot, determine the set of visible motion IDs that already have a
    # submitted Vote row.
    voted_by_lot_result = await db.execute(
        _select(_Vote.lot_owner_id, _Vote.motion_id).where(
            _Vote.general_meeting_id == general_meeting_id,
            _Vote.lot_owner_id.in_(all_lot_owner_ids),
            _Vote.status == _VoteStatus.submitted,
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
        lots.append(_LotInfo(
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


async def cleanup_expired_otps() -> None:
    """Delete expired OTP records — runs as a BackgroundTask."""
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                delete(AuthOtp).where(AuthOtp.expires_at < datetime.now(UTC))
            )
            await session.commit()
    except Exception:  # pragma: no cover
        pass  # Background cleanup — never let failures surface to the caller


async def cleanup_expired_sessions() -> None:
    """Delete expired session records — runs as a BackgroundTask."""
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                delete(SessionRecord).where(SessionRecord.expires_at < datetime.now(UTC))
            )
            await session.commit()
    except Exception:  # pragma: no cover
        pass  # Background cleanup — never let failures surface to the caller


async def create_session(
    db: AsyncSession,
    voter_email: str,
    building_id: uuid.UUID,
    general_meeting_id: uuid.UUID,
) -> str:
    """Create a new session record and return a signed session token.

    The raw token is stored in the DB; the returned value is a signed
    itsdangerous token that the client must present to restore the session.
    """
    raw_token = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    session = SessionRecord(
        session_token=raw_token,
        voter_email=voter_email,
        building_id=building_id,
        general_meeting_id=general_meeting_id,
        expires_at=now + SESSION_DURATION,
    )
    db.add(session)
    await db.flush()
    return _sign_token(raw_token)


async def extend_session(
    db: AsyncSession,
    session_record: SessionRecord,
) -> str:
    """Extend the expiry of an existing session and return a freshly signed token.

    The raw token in the DB is reused; only expires_at is updated.
    The returned signed token is re-signed with a fresh timestamp so that
    the client cookie max_age resets from now.

    Use this in restore_session instead of create_session to avoid inserting
    a new row on every page reload — each voter has at most one active session.
    """
    session_record.expires_at = datetime.now(UTC) + SESSION_DURATION
    await db.flush()
    return _sign_token(session_record.session_token)


async def get_session(
    general_meeting_id: uuid.UUID,
    db: AsyncSession,
    agm_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> SessionRecord:
    """
    Validate the session token from either the agm_session cookie or the
    Authorization header (Bearer token). Returns the SessionRecord if valid.
    Raises 401 if no valid session is found.
    """
    signed_token: str | None = agm_session

    if signed_token is None and authorization is not None:
        if authorization.startswith("Bearer "):
            signed_token = authorization[len("Bearer "):]

    if signed_token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Verify signature before hitting the DB
    raw_token = _unsign_token(signed_token)

    now = datetime.now(UTC)
    result = await db.execute(
        select(SessionRecord).where(
            SessionRecord.session_token == raw_token,
            SessionRecord.general_meeting_id == general_meeting_id,
            SessionRecord.expires_at > now,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return session
#
