"""ensure_ballot_submission_unique_constraint

Revision ID: 0a4eb6ea160a
Revises: rr4001schema
Create Date: 2026-04-04 01:53:45.813623

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0a4eb6ea160a'
down_revision: Union[str, Sequence[str], None] = 'rr4001schema'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Ensure uq_ballot_submissions_gm_lot_owner constraint exists.

    The unique constraint on (general_meeting_id, lot_owner_id) is required to
    prevent concurrent duplicate ballot submissions.  On the demo Neon DB the
    constraint was lost during a migration-history inconsistency, allowing all
    concurrent submit requests to succeed and producing duplicate rows.

    This migration is idempotent: it checks for the constraint before adding it
    so running it against a DB that already has the constraint is a no-op.
    """
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT 1 FROM pg_constraint "
            "WHERE conname = 'uq_ballot_submissions_gm_lot_owner' "
            "AND conrelid = 'ballot_submissions'::regclass"
        )
    )
    if result.fetchone() is None:
        # First deduplicate any existing rows that would violate the constraint.
        # Keep the row with the earliest submitted_at; delete all others.
        conn.execute(
            sa.text(
                """
                DELETE FROM ballot_submissions
                WHERE id NOT IN (
                    SELECT DISTINCT ON (general_meeting_id, lot_owner_id) id
                    FROM ballot_submissions
                    ORDER BY general_meeting_id, lot_owner_id, submitted_at ASC
                )
                """
            )
        )
        op.create_unique_constraint(
            "uq_ballot_submissions_gm_lot_owner",
            "ballot_submissions",
            ["general_meeting_id", "lot_owner_id"],
        )


def downgrade() -> None:
    """Remove the constraint (returns DB to the broken state — use only in testing)."""
    op.drop_constraint(
        "uq_ballot_submissions_gm_lot_owner",
        "ballot_submissions",
        type_="unique",
    )
