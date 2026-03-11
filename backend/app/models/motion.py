import enum
import uuid

from sqlalchemy import Enum, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class MotionType(str, enum.Enum):
    general = "general"
    special = "special"


class Motion(Base):
    __tablename__ = "motions"
    __table_args__ = (
        UniqueConstraint("agm_id", "order_index", name="uq_motions_agm_order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    agm_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agms.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False)
    motion_type: Mapped[MotionType] = mapped_column(
        Enum(MotionType, name="motiontype"),
        nullable=False,
        default=MotionType.general,
        server_default="general",
    )

    # Relationships
    agm: Mapped["AGM"] = relationship(  # noqa: F821
        "AGM", back_populates="motions"
    )
    votes: Mapped[list["Vote"]] = relationship(  # noqa: F821
        "Vote", back_populates="motion", cascade="all, delete-orphan"
    )
