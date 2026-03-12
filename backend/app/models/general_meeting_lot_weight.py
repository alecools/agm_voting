import enum
import uuid

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class FinancialPositionSnapshot(str, enum.Enum):
    normal = "normal"
    in_arrear = "in_arrear"


class GeneralMeetingLotWeight(Base):
    __tablename__ = "general_meeting_lot_weights"
    __table_args__ = (
        UniqueConstraint("general_meeting_id", "lot_owner_id", name="uq_general_meeting_lot_weights_gm_lot"),
        CheckConstraint(
            "unit_entitlement_snapshot >= 0",
            name="ck_agm_lot_weights_entitlement_nonneg",
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
    lot_owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("lot_owners.id", ondelete="CASCADE"),
        nullable=False,
    )
    unit_entitlement_snapshot: Mapped[int] = mapped_column(Integer, nullable=False)
    financial_position_snapshot: Mapped[FinancialPositionSnapshot] = mapped_column(
        Enum(FinancialPositionSnapshot, name="financialpositionsnapshot"),
        nullable=False,
        default=FinancialPositionSnapshot.normal,
        server_default=FinancialPositionSnapshot.normal.value,
    )

    # Relationships
    general_meeting: Mapped["GeneralMeeting"] = relationship(  # noqa: F821
        "GeneralMeeting", back_populates="general_meeting_lot_weights"
    )
    lot_owner: Mapped["LotOwner"] = relationship(  # noqa: F821
        "LotOwner", back_populates="general_meeting_lot_weights"
    )
