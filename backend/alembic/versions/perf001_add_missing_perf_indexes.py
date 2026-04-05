"""add_missing_perf_indexes

Revision ID: perf001indexes
Revises: rr4001schema
Create Date: 2026-04-05 00:00:00.000000

Changes:
  Add 6 missing performance indexes identified by query audit:
  - votes(lot_owner_id): voting_service lot_owner_id.in_() filters
  - votes(motion_id): FK join operations
  - votes(motion_option_id): nullable FK filter operations
  - general_meetings(building_id): admin building-scoped queries
  - motions(general_meeting_id, is_visible): voter motion visibility queries
  - session_records(general_meeting_id): FK cascade and lookup queries
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "perf001indexes"
down_revision: Union[str, Sequence[str], None] = "0a4eb6ea160a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_votes_lot_owner_id", "votes", ["lot_owner_id"])
    op.create_index("ix_votes_motion_id", "votes", ["motion_id"])
    op.create_index("ix_votes_motion_option_id", "votes", ["motion_option_id"])
    op.create_index("ix_general_meetings_building_id", "general_meetings", ["building_id"])
    op.create_index("ix_motions_gm_is_visible", "motions", ["general_meeting_id", "is_visible"])
    op.create_index("ix_session_records_general_meeting_id", "session_records", ["general_meeting_id"])


def downgrade() -> None:
    op.drop_index("ix_session_records_general_meeting_id", table_name="session_records")
    op.drop_index("ix_motions_gm_is_visible", table_name="motions")
    op.drop_index("ix_general_meetings_building_id", table_name="general_meetings")
    op.drop_index("ix_votes_motion_option_id", table_name="votes")
    op.drop_index("ix_votes_motion_id", table_name="votes")
    op.drop_index("ix_votes_lot_owner_id", table_name="votes")
