"""add tenant_config table

Revision ID: 091b1c8142bb
Revises: 0e7439a74cb6
Create Date: 2026-03-22 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "091b1c8142bb"
down_revision = "0e7439a74cb6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tenant_config",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("app_name", sa.String(200), nullable=False),
        sa.Column("logo_url", sa.String(2048), nullable=False, server_default=""),
        sa.Column("primary_colour", sa.String(7), nullable=False),
        sa.Column("support_email", sa.String(254), nullable=False, server_default=""),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # Idempotent seed: insert the default row only if it doesn't already exist
    op.execute(
        """
        INSERT INTO tenant_config (id, app_name, logo_url, primary_colour, support_email)
        SELECT 1, 'AGM Voting', '', '#005f73', ''
        WHERE NOT EXISTS (SELECT 1 FROM tenant_config WHERE id = 1)
        """
    )


def downgrade() -> None:
    op.drop_table("tenant_config")
