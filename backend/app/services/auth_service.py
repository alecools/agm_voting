"""
Session creation and validation logic for lot owner authentication.
"""
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Cookie, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session_record import SessionRecord

SESSION_DURATION_HOURS = 24  # kept for backward compatibility
SESSION_DURATION = timedelta(minutes=30)


async def create_session(
    db: AsyncSession,
    voter_email: str,
    building_id: uuid.UUID,
    general_meeting_id: uuid.UUID,
) -> str:
    """Create a new session record and return the session token."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    session = SessionRecord(
        session_token=token,
        voter_email=voter_email,
        building_id=building_id,
        general_meeting_id=general_meeting_id,
        expires_at=now + SESSION_DURATION,
    )
    db.add(session)
    await db.flush()
    return token


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
    token: str | None = agm_session

    if token is None and authorization is not None:
        if authorization.startswith("Bearer "):
            token = authorization[len("Bearer "):]

    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    now = datetime.now(UTC)
    result = await db.execute(
        select(SessionRecord).where(
            SessionRecord.session_token == token,
            SessionRecord.general_meeting_id == general_meeting_id,
            SessionRecord.expires_at > now,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return session
