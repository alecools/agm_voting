import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class VoteChoice(str, enum.Enum):
    yes = "yes"
    no = "no"
    abstained = "abstained"


class VoteStatus(str, enum.Enum):
    draft = "draft"
    submitted = "submitted"


class Vote(Base):
    __tablename__ = "votes"
    __table_args__ = (
        UniqueConstraint(
            "agm_id", "motion_id", "voter_email",
            name="uq_votes_agm_motion_voter",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    agm_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agms.id", ondelete="CASCADE"),
        nullable=False,
    )
    motion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("motions.id", ondelete="CASCADE"),
        nullable=False,
    )
    voter_email: Mapped[str] = mapped_column(String, nullable=False)
    choice: Mapped[VoteChoice | None] = mapped_column(
        Enum(VoteChoice, name="votechoice"),
        nullable=True,
    )
    status: Mapped[VoteStatus] = mapped_column(
        Enum(VoteStatus, name="votestatus"),
        nullable=False,
        default=VoteStatus.draft,
        server_default=VoteStatus.draft.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Relationships
    agm: Mapped["AGM"] = relationship(  # noqa: F821
        "AGM", back_populates="votes"
    )
    motion: Mapped["Motion"] = relationship(  # noqa: F821
        "Motion", back_populates="votes"
    )
