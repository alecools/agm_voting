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
from app.logging_config import get_logger
from app.models.session_record import SessionRecord

logger = get_logger(__name__)

SESSION_DURATION_HOURS = 24  # kept for backward compatibility
SESSION_DURATION = timedelta(minutes=30)

# Maximum age for a signed session token — slightly longer than SESSION_DURATION
# so that the DB expiry check is the authoritative guard, not the signature age.
_TOKEN_MAX_AGE_SECONDS = 86400  # 24 hours


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
