import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class LotProxy(Base):
    __tablename__ = "lot_proxies"
    __table_args__ = (
        UniqueConstraint("lot_id", name="uq_lot_proxies_lot_id"),
        Index("ix_lot_proxies_person_id", "person_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    lot_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("lots.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    lot: Mapped["Lot"] = relationship(  # noqa: F821
        "Lot", back_populates="lot_proxy"
    )
    person: Mapped["Person"] = relationship(  # noqa: F821
        "Person", back_populates="proxied_lots"
    )
