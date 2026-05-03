"""add unarchive_count to buildings

Revision ID: uc0001unarchivecnt
Revises: c37e58379bfd
Create Date: 2026-05-04 00:00:00.000000

Changes:
  - Add unarchive_count column to buildings (integer, NOT NULL, DEFAULT 0)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "uc0001unarchivecnt"
down_revision = "c37e58379bfd"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "buildings",
        sa.Column(
            "unarchive_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("buildings", "unarchive_count")
