"""
SQLAlchemy model for the singleton SMTP configuration row.

The table enforces a single row via a CHECK constraint (id = 1).
The smtp_password_enc column stores the AES-256-GCM encrypted password;
it is never returned to clients.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import CheckConstraint, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TenantSmtpConfig(Base):
    __tablename__ = "tenant_smtp_config"
    __table_args__ = (CheckConstraint("id = 1", name="ck_tenant_smtp_config_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    smtp_host: Mapped[str] = mapped_column(String(253), nullable=False, default="")
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False, default=587)
    smtp_username: Mapped[str] = mapped_column(String(254), nullable=False, default="")
    smtp_password_enc: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    smtp_from_email: Mapped[str] = mapped_column(String(254), nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
