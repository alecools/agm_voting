from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TenantSettings(Base):
    """Singleton table for per-tenant subscription and plan settings.

    Enforced as a single-row table via a CHECK constraint on id = 1.
    building_limit = None means unlimited buildings.
    """

    __tablename__ = "tenant_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    tier_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    building_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (CheckConstraint("id = 1", name="ck_tenant_settings_singleton"),)
