import enum
import uuid

import sqlalchemy as sa
from sqlalchemy import Boolean, Enum, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class MotionType(str, enum.Enum):
    general = "general"
    special = "special"


class Motion(Base):
    __tablename__ = "motions"
    __table_args__ = (
        UniqueConstraint(
            "general_meeting_id",
            "display_order",
            name="uq_motions_general_meeting_display_order",
        ),
        # Partial unique index: motion_number uniqueness per meeting, NULLs excluded.
        # Multiple motions may have motion_number = NULL; only non-null values are unique.
        # Standard UniqueConstraint cannot express a WHERE clause, so Index is used instead.
        Index(
            "uq_motions_general_meeting_motion_number",
            "general_meeting_id",
            "motion_number",
            unique=True,
            postgresql_where=text("motion_number IS NOT NULL"),  # nosemgrep: raw-sql-requires-comment -- partial index WHERE predicate; SQLAlchemy ORM has no non-text() alternative for database-level partial index expressions
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    general_meeting_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("general_meetings.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False)
    motion_number: Mapped[str | None] = mapped_column(String, nullable=True)
    motion_type: Mapped[MotionType] = mapped_column(
        Enum(MotionType, name="motiontype"),
        nullable=False,
        default=MotionType.general,
        server_default="general",
    )
    is_visible: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=sa.text("true"),  # nosemgrep: raw-sql-requires-comment -- server_default for boolean column; SQLAlchemy requires text() to emit a literal SQL expression as a column default
    )

    # Relationships
    general_meeting: Mapped["GeneralMeeting"] = relationship(  # noqa: F821
        "GeneralMeeting", back_populates="motions"
    )
    votes: Mapped[list["Vote"]] = relationship(  # noqa: F821
        "Vote", back_populates="motion", cascade="all, delete-orphan"
    )
