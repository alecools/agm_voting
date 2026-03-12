import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class GeneralMeetingStatus(str, enum.Enum):
    open = "open"
    closed = "closed"


def get_effective_status(meeting: "GeneralMeeting") -> GeneralMeetingStatus:
    """Return the effective status of a GeneralMeeting.

    If the meeting's voting_closes_at is in the past and the stored status is
    still ``open``, the effective status is ``closed``.  This lets the API
    surface a closed status before the background auto-close job has run.
    """
    if meeting.status == GeneralMeetingStatus.open and meeting.voting_closes_at is not None:
        # Make the comparison timezone-aware regardless of how the timestamp
        # was stored (with or without tzinfo).
        closes_at = meeting.voting_closes_at
        if closes_at.tzinfo is None:
            closes_at = closes_at.replace(tzinfo=UTC)
        if closes_at < datetime.now(UTC):
            return GeneralMeetingStatus.closed
    return meeting.status


class GeneralMeeting(Base):
    __tablename__ = "general_meetings"
    __table_args__ = (
        CheckConstraint(
            "voting_closes_at > meeting_at",
            name="ck_general_meeting_voting_closes_after_meeting",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    building_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("buildings.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[GeneralMeetingStatus] = mapped_column(
        Enum(GeneralMeetingStatus, name="generalmeetingstatus"),
        nullable=False,
        default=GeneralMeetingStatus.open,
        server_default=GeneralMeetingStatus.open.value,
    )
    meeting_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    voting_closes_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Relationships
    building: Mapped["Building"] = relationship(  # noqa: F821
        "Building", back_populates="general_meetings"
    )
    motions: Mapped[list["Motion"]] = relationship(  # noqa: F821
        "Motion", back_populates="general_meeting", cascade="all, delete-orphan"
    )
    general_meeting_lot_weights: Mapped[list["GeneralMeetingLotWeight"]] = relationship(  # noqa: F821
        "GeneralMeetingLotWeight", back_populates="general_meeting", cascade="all, delete-orphan"
    )
    votes: Mapped[list["Vote"]] = relationship(  # noqa: F821
        "Vote", back_populates="general_meeting", cascade="all, delete-orphan"
    )
    ballot_submissions: Mapped[list["BallotSubmission"]] = relationship(  # noqa: F821
        "BallotSubmission", back_populates="general_meeting", cascade="all, delete-orphan"
    )
    session_records: Mapped[list["SessionRecord"]] = relationship(  # noqa: F821
        "SessionRecord", back_populates="general_meeting", cascade="all, delete-orphan"
    )
    email_delivery: Mapped["EmailDelivery | None"] = relationship(  # noqa: F821
        "EmailDelivery", back_populates="general_meeting", uselist=False, cascade="all, delete-orphan"
    )
