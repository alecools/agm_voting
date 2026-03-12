"""add pending to generalmeetingstatus enum

Revision ID: b4c5d6e7f8a9
Revises: f1a2b3c4d5e6
Create Date: 2026-03-13 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "b4c5d6e7f8a9"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction in PostgreSQL.
    # Use Alembic's autocommit_block() context manager to run the DDL outside
    # the migration transaction.
    with op.get_context().autocommit_block():
        op.execute(sa.text(
            "ALTER TYPE generalmeetingstatus ADD VALUE IF NOT EXISTS 'pending'"
        ))
    # Backfill: meetings that haven't started yet should be pending.
    op.execute(sa.text(
        "UPDATE general_meetings SET status = 'pending' "
        "WHERE meeting_at > NOW() AND status = 'open'"
    ))


def downgrade() -> None:
    # Revert pending meetings back to open.
    # PostgreSQL does not support removing enum values without recreating the
    # type — the 'pending' value will remain in the enum but be unused after
    # downgrade.
    op.execute(
        "UPDATE general_meetings SET status = 'open' WHERE status = 'pending'"
    )
