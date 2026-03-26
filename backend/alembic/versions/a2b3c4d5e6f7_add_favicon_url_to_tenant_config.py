"""add favicon_url to tenant_config

Revision ID: a2b3c4d5e6f7
Revises: 091b1c8142bb
Create Date: 2026-03-24 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "a2b3c4d5e6f7"
down_revision = "091b1c8142bb"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenant_config",
        sa.Column("favicon_url", sa.String(2048), nullable=True, server_default=None),
    )


def downgrade() -> None:
    op.drop_column("tenant_config", "favicon_url")
