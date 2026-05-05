import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class Person(Base):
    __tablename__ = "persons"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    given_name: Mapped[str | None] = mapped_column(String, nullable=True)
    surname: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    lots: Mapped[list["Lot"]] = relationship(  # noqa: F821
        "Lot", secondary="lot_persons", back_populates="persons"
    )
    proxied_lots: Mapped[list["LotProxy"]] = relationship(  # noqa: F821
        "LotProxy", back_populates="person"
    )
