import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class BallotSubmission(Base):
    __tablename__ = "ballot_submissions"
    __table_args__ = (
        UniqueConstraint("general_meeting_id", "lot_owner_id", name="uq_ballot_submissions_gm_lot_owner"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    general_meeting_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("general_meetings.id", ondelete="CASCADE"),
        nullable=False,
    )
    lot_owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("lot_owners.id", ondelete="CASCADE"),
        nullable=False,
    )
    voter_email: Mapped[str] = mapped_column(String, nullable=False)
    proxy_email: Mapped[str | None] = mapped_column(String, nullable=True, default=None)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    general_meeting: Mapped["GeneralMeeting"] = relationship(  # noqa: F821
        "GeneralMeeting", back_populates="ballot_submissions"
    )
    lot_owner: Mapped["LotOwner"] = relationship(  # noqa: F821
        "LotOwner", back_populates="ballot_submissions"
    )
