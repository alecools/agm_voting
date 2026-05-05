"""
Session creation and validation logic for lot owner authentication.
"""
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Cookie, Header, HTTPException
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import AsyncSessionLocal
from app.logging_config import get_logger
from app.models.lot import Lot
from app.models.lot_person import lot_persons
from app.models.lot_proxy import LotProxy
from app.models.person import Person
from app.models.session_record import SessionRecord

logger = get_logger(__name__)

SESSION_DURATION_HOURS = 24  # kept for backward compatibility
SESSION_DURATION = timedelta(minutes=30)

# Maximum age for a signed session token — matches SESSION_DURATION exactly
# so that a token cannot outlive the DB session record (RR3-36).
_TOKEN_MAX_AGE_SECONDS = int(SESSION_DURATION.total_seconds())  # 1800


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
