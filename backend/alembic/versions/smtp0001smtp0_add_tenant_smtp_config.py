"""add tenant_smtp_config table with seed from env vars

Revision ID: a1b2c3d4e5f6
Revises: f9a8b7c6d5e4
Create Date: 2026-04-02 00:00:00.000000

Changes:
  - Create tenant_smtp_config singleton table (id=1 enforced by CHECK constraint)
  - Data migration: seed from SMTP_* env vars if SMTP_HOST is set and table is empty
"""
from __future__ import annotations

import os

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "smtp0001smtp0"
down_revision = "a9c1d5e7f2b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tenant_smtp_config",
        sa.Column("id", sa.Integer(), primary_key=True, default=1),
        sa.Column("smtp_host", sa.String(253), nullable=False, server_default=""),
        sa.Column("smtp_port", sa.Integer(), nullable=False, server_default="587"),
        sa.Column("smtp_username", sa.String(254), nullable=False, server_default=""),
        sa.Column("smtp_password_enc", sa.String(512), nullable=True),
        sa.Column("smtp_from_email", sa.String(254), nullable=False, server_default=""),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("id = 1", name="ck_tenant_smtp_config_singleton"),
    )

    # Data migration: seed from env vars if SMTP_HOST is set
    smtp_host = os.environ.get("SMTP_HOST", "").strip()
    if smtp_host:
        smtp_port = int(os.environ.get("SMTP_PORT", "587") or "587")
        smtp_username = os.environ.get("SMTP_USERNAME", "").strip()
        smtp_from_email = os.environ.get("SMTP_FROM_EMAIL", "").strip()
        smtp_password = os.environ.get("SMTP_PASSWORD", "").strip()
        smtp_encryption_key = os.environ.get("SMTP_ENCRYPTION_KEY", "").strip()

        # Encrypt password if key is available
        smtp_password_enc = None
        if smtp_password and smtp_encryption_key:
            try:
                # Import here to avoid import-time failure when cryptography is absent
                from app.crypto import encrypt_smtp_password
                smtp_password_enc = encrypt_smtp_password(smtp_password, smtp_encryption_key)
            except Exception:
                # If encryption fails, leave password unset — admin must configure via UI
                smtp_password_enc = None

        conn = op.get_bind()
        # Idempotent: only insert if no row exists
        result = conn.execute(sa.text("SELECT COUNT(*) FROM tenant_smtp_config"))
        count = result.scalar()
        if count == 0:
            conn.execute(
                sa.text(
                    "INSERT INTO tenant_smtp_config "
                    "(id, smtp_host, smtp_port, smtp_username, smtp_password_enc, smtp_from_email) "
                    "VALUES (1, :host, :port, :username, :password_enc, :from_email)"
                ),
                {
                    "host": smtp_host,
                    "port": smtp_port,
                    "username": smtp_username,
                    "password_enc": smtp_password_enc,
                    "from_email": smtp_from_email,
                },
            )


def downgrade() -> None:
    op.drop_table("tenant_smtp_config")
