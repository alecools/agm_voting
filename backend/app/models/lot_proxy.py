import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class LotProxy(Base):
    __tablename__ = "lot_proxies"
    __table_args__ = (
        UniqueConstraint("lot_owner_id", name="uq_lot_proxies_lot_owner_id"),
        Index("ix_lot_proxies_proxy_email", "proxy_email"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    lot_owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("lot_owners.id", ondelete="CASCADE"),
        nullable=False,
    )
    proxy_email: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    lot_owner: Mapped["LotOwner"] = relationship(  # noqa: F821
        "LotOwner", back_populates="lot_proxy"
    )
