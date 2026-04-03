import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class MotionOption(Base):
    __tablename__ = "motion_options"
    __table_args__ = (
        UniqueConstraint(
            "motion_id",
            "display_order",
            name="uq_motion_options_motion_display_order",
        ),
        CheckConstraint(
            "outcome IN ('pass', 'fail', 'tie') OR outcome IS NULL",
            name="ck_motion_options_outcome",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    motion_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("motions.id", ondelete="CASCADE"),
        nullable=False,
    )
    text: Mapped[str] = mapped_column(String, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    outcome: Mapped[str | None] = mapped_column(String, nullable=True, default=None)

    # For/Against/Abstained tally snapshots (stored at meeting close)
    for_voter_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    for_entitlement_sum: Mapped[int] = mapped_column(Numeric, nullable=False, default=0)
    against_voter_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    against_entitlement_sum: Mapped[int] = mapped_column(Numeric, nullable=False, default=0)
    abstained_voter_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    abstained_entitlement_sum: Mapped[int] = mapped_column(Numeric, nullable=False, default=0)

    # Relationship back to Motion
    motion: Mapped["Motion"] = relationship("Motion", back_populates="options")  # noqa: F821
