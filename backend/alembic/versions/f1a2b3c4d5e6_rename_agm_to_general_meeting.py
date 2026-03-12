"""rename AGM to General Meeting

Revision ID: f1a2b3c4d5e6
Revises: e5f6a7b8c9d0
Create Date: 2026-03-13 00:00:00.000000

"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "f1a2b3c4d5e6"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Rename the PostgreSQL enum type
    op.execute("ALTER TYPE agmstatus RENAME TO generalmeetingstatus")

    # 2. Rename table agms -> general_meetings
    op.execute("ALTER TABLE agms RENAME TO general_meetings")

    # 3. Rename agm_id -> general_meeting_id and recreate FKs for each child table

    # agm_lot_weights
    op.execute("ALTER TABLE agm_lot_weights DROP CONSTRAINT IF EXISTS agm_lot_weights_agm_id_fkey")
    op.alter_column("agm_lot_weights", "agm_id", new_column_name="general_meeting_id")
    op.create_foreign_key(
        None, "agm_lot_weights", "general_meetings", ["general_meeting_id"], ["id"], ondelete="CASCADE"
    )

    # motions
    op.execute("ALTER TABLE motions DROP CONSTRAINT IF EXISTS motions_agm_id_fkey")
    op.alter_column("motions", "agm_id", new_column_name="general_meeting_id")
    op.create_foreign_key(
        None, "motions", "general_meetings", ["general_meeting_id"], ["id"], ondelete="CASCADE"
    )

    # ballot_submissions
    op.execute("ALTER TABLE ballot_submissions DROP CONSTRAINT IF EXISTS ballot_submissions_agm_id_fkey")
    op.alter_column("ballot_submissions", "agm_id", new_column_name="general_meeting_id")
    op.create_foreign_key(
        None, "ballot_submissions", "general_meetings", ["general_meeting_id"], ["id"], ondelete="CASCADE"
    )

    # votes
    op.execute("ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_agm_id_fkey")
    op.alter_column("votes", "agm_id", new_column_name="general_meeting_id")
    op.create_foreign_key(
        None, "votes", "general_meetings", ["general_meeting_id"], ["id"], ondelete="CASCADE"
    )

    # session_records
    op.execute("ALTER TABLE session_records DROP CONSTRAINT IF EXISTS session_records_agm_id_fkey")
    op.alter_column("session_records", "agm_id", new_column_name="general_meeting_id")
    op.create_foreign_key(
        None, "session_records", "general_meetings", ["general_meeting_id"], ["id"], ondelete="CASCADE"
    )

    # email_deliveries
    op.execute("ALTER TABLE email_deliveries DROP CONSTRAINT IF EXISTS email_deliveries_agm_id_fkey")
    # Also drop the unique constraint on agm_id before renaming
    op.execute("ALTER TABLE email_deliveries DROP CONSTRAINT IF EXISTS email_deliveries_agm_id_key")
    op.alter_column("email_deliveries", "agm_id", new_column_name="general_meeting_id")
    op.create_foreign_key(
        None, "email_deliveries", "general_meetings", ["general_meeting_id"], ["id"], ondelete="CASCADE"
    )
    # Recreate the unique constraint with new column name
    op.execute("ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_general_meeting_id_key UNIQUE (general_meeting_id)")

    # 4. Rename table agm_lot_weights -> general_meeting_lot_weights
    op.execute("ALTER TABLE agm_lot_weights RENAME TO general_meeting_lot_weights")

    # 5. Rename unique/check constraints

    # general_meeting_lot_weights (formerly agm_lot_weights)
    op.execute("ALTER TABLE general_meeting_lot_weights DROP CONSTRAINT IF EXISTS uq_agm_lot_weights_agm_lot")
    op.execute("ALTER TABLE general_meeting_lot_weights ADD CONSTRAINT uq_general_meeting_lot_weights_gm_lot UNIQUE (general_meeting_id, lot_owner_id)")

    # motions
    op.execute("ALTER TABLE motions DROP CONSTRAINT IF EXISTS uq_motions_agm_order")
    op.execute("ALTER TABLE motions ADD CONSTRAINT uq_motions_general_meeting_order UNIQUE (general_meeting_id, order_index)")

    # ballot_submissions
    op.execute("ALTER TABLE ballot_submissions DROP CONSTRAINT IF EXISTS uq_ballot_submissions_agm_lot_owner")
    op.execute("ALTER TABLE ballot_submissions ADD CONSTRAINT uq_ballot_submissions_gm_lot_owner UNIQUE (general_meeting_id, lot_owner_id)")

    # votes
    op.execute("ALTER TABLE votes DROP CONSTRAINT IF EXISTS uq_votes_agm_motion_lot_owner")
    op.execute("ALTER TABLE votes ADD CONSTRAINT uq_votes_gm_motion_lot_owner UNIQUE (general_meeting_id, motion_id, lot_owner_id)")

    # general_meetings check constraint
    op.execute("ALTER TABLE general_meetings DROP CONSTRAINT IF EXISTS ck_agm_voting_closes_after_meeting")
    op.execute("ALTER TABLE general_meetings ADD CONSTRAINT ck_general_meeting_voting_closes_after_meeting CHECK (voting_closes_at > meeting_at)")


def downgrade() -> None:
    # Reverse all changes in reverse order

    # 5. Restore constraint names
    op.execute("ALTER TABLE general_meetings DROP CONSTRAINT IF EXISTS ck_general_meeting_voting_closes_after_meeting")
    op.execute("ALTER TABLE general_meetings ADD CONSTRAINT ck_agm_voting_closes_after_meeting CHECK (voting_closes_at > meeting_at)")

    op.execute("ALTER TABLE votes DROP CONSTRAINT IF EXISTS uq_votes_gm_motion_lot_owner")
    op.execute("ALTER TABLE votes ADD CONSTRAINT uq_votes_agm_motion_lot_owner UNIQUE (general_meeting_id, motion_id, lot_owner_id)")

    op.execute("ALTER TABLE ballot_submissions DROP CONSTRAINT IF EXISTS uq_ballot_submissions_gm_lot_owner")
    op.execute("ALTER TABLE ballot_submissions ADD CONSTRAINT uq_ballot_submissions_agm_lot_owner UNIQUE (general_meeting_id, lot_owner_id)")

    op.execute("ALTER TABLE motions DROP CONSTRAINT IF EXISTS uq_motions_general_meeting_order")
    op.execute("ALTER TABLE motions ADD CONSTRAINT uq_motions_agm_order UNIQUE (general_meeting_id, order_index)")

    op.execute("ALTER TABLE general_meeting_lot_weights DROP CONSTRAINT IF EXISTS uq_general_meeting_lot_weights_gm_lot")
    op.execute("ALTER TABLE general_meeting_lot_weights ADD CONSTRAINT uq_agm_lot_weights_agm_lot UNIQUE (general_meeting_id, lot_owner_id)")

    # 4. Rename table back
    op.execute("ALTER TABLE general_meeting_lot_weights RENAME TO agm_lot_weights")

    # 3. Rename general_meeting_id -> agm_id and recreate FKs

    # email_deliveries
    op.execute("ALTER TABLE email_deliveries DROP CONSTRAINT IF EXISTS email_deliveries_general_meeting_id_key")
    op.execute("ALTER TABLE email_deliveries DROP CONSTRAINT IF EXISTS email_deliveries_general_meeting_id_fkey")
    op.alter_column("email_deliveries", "general_meeting_id", new_column_name="agm_id")
    op.execute("ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_agm_id_key UNIQUE (agm_id)")
    op.create_foreign_key(
        "email_deliveries_agm_id_fkey", "email_deliveries", "general_meetings", ["agm_id"], ["id"], ondelete="CASCADE"
    )

    # session_records
    op.execute("ALTER TABLE session_records DROP CONSTRAINT IF EXISTS session_records_general_meeting_id_fkey")
    op.alter_column("session_records", "general_meeting_id", new_column_name="agm_id")
    op.create_foreign_key(
        "session_records_agm_id_fkey", "session_records", "general_meetings", ["agm_id"], ["id"], ondelete="CASCADE"
    )

    # votes
    op.execute("ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_general_meeting_id_fkey")
    op.alter_column("votes", "general_meeting_id", new_column_name="agm_id")
    op.create_foreign_key(
        "votes_agm_id_fkey", "votes", "general_meetings", ["agm_id"], ["id"], ondelete="CASCADE"
    )

    # ballot_submissions
    op.execute("ALTER TABLE ballot_submissions DROP CONSTRAINT IF EXISTS ballot_submissions_general_meeting_id_fkey")
    op.alter_column("ballot_submissions", "general_meeting_id", new_column_name="agm_id")
    op.create_foreign_key(
        "ballot_submissions_agm_id_fkey", "ballot_submissions", "general_meetings", ["agm_id"], ["id"], ondelete="CASCADE"
    )

    # motions
    op.execute("ALTER TABLE motions DROP CONSTRAINT IF EXISTS motions_general_meeting_id_fkey")
    op.alter_column("motions", "general_meeting_id", new_column_name="agm_id")
    op.create_foreign_key(
        "motions_agm_id_fkey", "motions", "general_meetings", ["agm_id"], ["id"], ondelete="CASCADE"
    )

    # agm_lot_weights
    op.execute("ALTER TABLE agm_lot_weights DROP CONSTRAINT IF EXISTS agm_lot_weights_general_meeting_id_fkey")
    op.alter_column("agm_lot_weights", "general_meeting_id", new_column_name="agm_id")
    op.create_foreign_key(
        "agm_lot_weights_agm_id_fkey", "agm_lot_weights", "general_meetings", ["agm_id"], ["id"], ondelete="CASCADE"
    )

    # 2. Rename table back
    op.execute("ALTER TABLE general_meetings RENAME TO agms")

    # 1. Rename enum type back
    op.execute("ALTER TYPE generalmeetingstatus RENAME TO agmstatus")
