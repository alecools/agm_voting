import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class BallotSubmission(Base):
    __tablename__ = "ballot_submissions"
    __table_args__ = (
        UniqueConstraint("agm_id", "voter_email", name="uq_ballot_submissions_agm_voter"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    agm_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agms.id", ondelete="CASCADE"),
        nullable=False,
    )
    voter_email: Mapped[str] = mapped_column(String, nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    agm: Mapped["AGM"] = relationship(  # noqa: F821
        "AGM", back_populates="ballot_submissions"
    )
