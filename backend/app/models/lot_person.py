from sqlalchemy import Column, ForeignKey, Index, Table

from app.models.base import Base

lot_persons = Table(
    "lot_persons",
    Base.metadata,
    Column("lot_id", ForeignKey("lots.id", ondelete="CASCADE"), primary_key=True),
    Column("person_id", ForeignKey("persons.id", ondelete="RESTRICT"), primary_key=True),
    Index("ix_lot_persons_person_id", "person_id"),
)
