import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class FinancialPosition(str, enum.Enum):
    normal = "normal"
    in_arrear = "in_arrear"


class Lot(Base):
    __tablename__ = "lots"
    __table_args__ = (
        UniqueConstraint("building_id", "lot_number", name="uq_lots_building_lot"),
        CheckConstraint("unit_entitlement > 0", name="ck_lots_entitlement_positive"),
        CheckConstraint("lot_number <> ''", name="ck_lots_lot_number_nonempty"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    building_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("buildings.id", ondelete="CASCADE"),
        nullable=False,
    )
    lot_number: Mapped[str] = mapped_column(String, nullable=False)
    unit_entitlement: Mapped[int] = mapped_column(Integer, nullable=False)
    financial_position: Mapped[FinancialPosition] = mapped_column(
        Enum(FinancialPosition, name="financialposition"),
        nullable=False,
        default=FinancialPosition.normal,
        server_default=FinancialPosition.normal.value,
    )
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
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
    building: Mapped["Building"] = relationship(  # noqa: F821
        "Building", back_populates="lot_owners"
    )
    persons: Mapped[list["Person"]] = relationship(  # noqa: F821
        "Person", secondary="lot_persons", back_populates="lots"
    )
    general_meeting_lot_weights: Mapped[list["GeneralMeetingLotWeight"]] = relationship(  # noqa: F821
        "GeneralMeetingLotWeight", back_populates="lot", cascade="all, delete-orphan"
    )
    ballot_submissions: Mapped[list["BallotSubmission"]] = relationship(  # noqa: F821
        "BallotSubmission", back_populates="lot_owner", cascade="all, delete-orphan"
    )
    lot_proxy: Mapped["LotProxy | None"] = relationship(  # noqa: F821
        "LotProxy", back_populates="lot", cascade="all, delete-orphan", uselist=False
    )


# Backward-compatible alias so code that still imports LotOwner continues to work
# during the transition period.
LotOwner = Lot
