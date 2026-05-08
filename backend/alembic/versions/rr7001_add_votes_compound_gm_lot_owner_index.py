"""add_votes_compound_gm_lot_owner_index

Revision ID: rr7001compoundvotes
Revises: pers0001personsref
Create Date: 2026-05-08 00:00:00.000000

Changes:
  Add compound index ix_votes_gm_lot_owner on votes(general_meeting_id, lot_owner_id).
  The hot query in submit_ballot and _resolve_voter_state filters on both columns;
  the compound index is more selective than the existing single-column index.
  The existing ix_votes_lot_owner_id is retained for lot_owner_id-only queries
  (cascade-delete lookups).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "rr7001compoundvotes"
down_revision: Union[str, Sequence[str], None] = "pers0001personsref"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_votes_gm_lot_owner",
        "votes",
        ["general_meeting_id", "lot_owner_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_votes_gm_lot_owner", table_name="votes")
