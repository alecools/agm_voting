import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class Building(Base):
    __tablename__ = "buildings"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    manager_email: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    lot_owners: Mapped[list["LotOwner"]] = relationship(  # noqa: F821
        "LotOwner", back_populates="building", cascade="all, delete-orphan"
    )
    agms: Mapped[list["AGM"]] = relationship(  # noqa: F821
        "AGM", back_populates="building", cascade="all, delete-orphan"
    )
    session_records: Mapped[list["SessionRecord"]] = relationship(  # noqa: F821
        "SessionRecord", back_populates="building", cascade="all, delete-orphan"
    )
