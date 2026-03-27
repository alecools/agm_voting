from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AdminLoginAttempt(Base):
    """Tracks failed admin login attempts for brute-force rate limiting.

    A fixed 15-minute window is used: once 5 failed attempts accumulate within
    15 minutes of the *first* failed attempt, all subsequent attempts (success or
    failure) are blocked with 429 until the window expires.

    Successful login resets the counter for the IP by deleting the row.
    """

    __tablename__ = "admin_login_attempts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    ip_address: Mapped[str] = mapped_column(String, nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    first_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    last_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        Index("ix_admin_login_attempts_ip", "ip_address", unique=True),
    )
