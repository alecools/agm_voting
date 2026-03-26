"""backfill motion_number from display_order for null rows

Motions created before the auto-populate feature (PR #122) were stored with
motion_number = NULL.  Those rows now show display_order as their label in
the admin UI; after a reorder their label would change, which is confusing.

This data migration sets motion_number = CAST(display_order AS VARCHAR) for
every motion row that still has motion_number IS NULL, making the label stable
regardless of future reorders.

downgrade() is a no-op: we cannot safely reverse a data backfill because we
cannot distinguish rows that were NULL before the migration from rows that
had a value set to their display_order string by the application.

Revision ID: 888085a72643
Revises: c1d2e3f4a5b6
Create Date: 2026-03-26 22:07:26.541940

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '888085a72643'
down_revision: Union[str, Sequence[str], None] = 'c1d2e3f4a5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Backfill motion_number from display_order for rows where it is NULL."""
    op.execute(
        "UPDATE motions SET motion_number = CAST(display_order AS VARCHAR) WHERE motion_number IS NULL"
    )


def downgrade() -> None:
    """No-op: data backfills cannot be safely reversed."""
    pass
