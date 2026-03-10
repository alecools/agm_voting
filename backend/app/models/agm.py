import enum
import uuid
from datetime import datetime

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


class AGMStatus(str, enum.Enum):
    open = "open"
    closed = "closed"


class AGM(Base):
    __tablename__ = "agms"
    __table_args__ = (
        CheckConstraint(
            "voting_closes_at > meeting_at",
            name="ck_agm_voting_closes_after_meeting",
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
    status: Mapped[AGMStatus] = mapped_column(
        Enum(AGMStatus, name="agmstatus"),
        nullable=False,
        default=AGMStatus.open,
        server_default=AGMStatus.open.value,
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
        "Building", back_populates="agms"
    )
    motions: Mapped[list["Motion"]] = relationship(  # noqa: F821
        "Motion", back_populates="agm", cascade="all, delete-orphan"
    )
    agm_lot_weights: Mapped[list["AGMLotWeight"]] = relationship(  # noqa: F821
        "AGMLotWeight", back_populates="agm", cascade="all, delete-orphan"
    )
    votes: Mapped[list["Vote"]] = relationship(  # noqa: F821
        "Vote", back_populates="agm", cascade="all, delete-orphan"
    )
    ballot_submissions: Mapped[list["BallotSubmission"]] = relationship(  # noqa: F821
        "BallotSubmission", back_populates="agm", cascade="all, delete-orphan"
    )
    session_records: Mapped[list["SessionRecord"]] = relationship(  # noqa: F821
        "SessionRecord", back_populates="agm", cascade="all, delete-orphan"
    )
    email_delivery: Mapped["EmailDelivery | None"] = relationship(  # noqa: F821
        "EmailDelivery", back_populates="agm", uselist=False, cascade="all, delete-orphan"
    )
