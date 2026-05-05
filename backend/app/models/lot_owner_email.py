import uuid
from typing import Optional

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class LotOwnerEmail(Base):
    __tablename__ = "lot_owner_emails"
    __table_args__ = (
        UniqueConstraint("lot_owner_id", "email", name="uq_lot_owner_emails_owner_email"),
        Index("ix_lot_owner_emails_email", "email"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    lot_owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("lot_owners.id", ondelete="CASCADE"),
        nullable=False,
    )
    email: Mapped[str | None] = mapped_column(String, nullable=True)
    given_name: Mapped[str | None] = mapped_column(String, nullable=True)
    surname: Mapped[str | None] = mapped_column(String, nullable=True)
    phone_number: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    # Relationships
    lot_owner: Mapped["LotOwner"] = relationship(  # noqa: F821
        "LotOwner", back_populates="emails"
    )
