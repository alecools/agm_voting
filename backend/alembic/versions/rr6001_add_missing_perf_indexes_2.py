"""add_missing_perf_indexes_2

Revision ID: rr6001perf2
Revises: perf001indexes
Create Date: 2026-04-06 00:00:00.000000

Changes:
  Add 3 additional missing performance indexes identified in RR6 performance review:
  - ballot_submissions(lot_owner_id): cascade delete full scan
  - session_records(expires_at): expiry filter full scan
  - buildings lower(name): functional index for case-insensitive lookups
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "rr6001perf2"
down_revision: Union[str, Sequence[str], None] = "perf001indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_ballot_submissions_lot_owner_id", "ballot_submissions", ["lot_owner_id"])
    op.create_index("ix_session_records_expires_at", "session_records", ["expires_at"])
    op.execute("CREATE INDEX ix_buildings_name_lower ON buildings (lower(name))")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_buildings_name_lower")
    op.drop_index("ix_session_records_expires_at", table_name="session_records")
    op.drop_index("ix_ballot_submissions_lot_owner_id", table_name="ballot_submissions")
