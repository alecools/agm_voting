"""add_tenant_settings_table

Revision ID: c37e58379bfd
Revises: bo001owneremails
Create Date: 2026-05-03 11:49:13.686262

Changes:
  - Create tenant_settings singleton table (id=1 enforced by CHECK constraint)
  - tier_name: optional plan name string
  - building_limit: optional integer cap on active (non-archived) buildings
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c37e58379bfd'
down_revision: Union[str, Sequence[str], None] = 'bo001owneremails'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_settings",
        sa.Column("id", sa.Integer(), primary_key=True, default=1),
        sa.Column("tier_name", sa.String(255), nullable=True),
        sa.Column("building_limit", sa.Integer(), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_tenant_settings_singleton"),
    )


def downgrade() -> None:
    op.drop_table("tenant_settings")
