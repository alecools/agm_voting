"""fix vote cascade to CASCADE, add indexes, add otp_rate_limits table

Revision ID: f9a8b7c6d5e4
Revises: a2b3c4d5e6f7
Create Date: 2026-03-25 00:00:00.000000

Changes:
  - votes.lot_owner_id: FK ondelete SET NULL → CASCADE, make NOT NULL
  - ballot_submissions.lot_owner_id: already CASCADE + NOT NULL — no FK change needed
  - Add composite indexes on (general_meeting_id, voter_email) for both tables
  - Create otp_rate_limits table for DB-backed OTP rate limiting
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "f9a8b7c6d5e4"
down_revision = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. Clean up any NULL lot_owner_id votes before making column NOT NULL
    # ------------------------------------------------------------------
    op.execute("DELETE FROM votes WHERE lot_owner_id IS NULL")

    # ------------------------------------------------------------------
    # 2. Fix votes.lot_owner_id: SET NULL → CASCADE, nullable → NOT NULL
    # ------------------------------------------------------------------
    op.drop_constraint("fk_votes_lot_owner_id", "votes", type_="foreignkey")
    op.alter_column(
        "votes",
        "lot_owner_id",
        existing_type=sa.UUID(),
        nullable=False,
    )
    op.create_foreign_key(
        "fk_votes_lot_owner_id",
        "votes",
        "lot_owners",
        ["lot_owner_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # ------------------------------------------------------------------
    # 3. Add missing performance indexes
    # ------------------------------------------------------------------
    op.create_index(
        "ix_ballot_submissions_gm_email",
        "ballot_submissions",
        ["general_meeting_id", "voter_email"],
    )
    op.create_index(
        "ix_votes_gm_email",
        "votes",
        ["general_meeting_id", "voter_email"],
    )

    # ------------------------------------------------------------------
    # 4. Create otp_rate_limits table
    # ------------------------------------------------------------------
    op.create_table(
        "otp_rate_limits",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("building_id", sa.UUID(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("first_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email", "building_id", name="uq_otp_rate_limit_email_building"),
    )
    op.create_index("ix_otp_rate_limits_email", "otp_rate_limits", ["email"])


def downgrade() -> None:
    # ------------------------------------------------------------------
    # 4. Drop otp_rate_limits table
    # ------------------------------------------------------------------
    op.drop_index("ix_otp_rate_limits_email", table_name="otp_rate_limits")
    op.drop_table("otp_rate_limits")

    # ------------------------------------------------------------------
    # 3. Drop performance indexes
    # ------------------------------------------------------------------
    op.drop_index("ix_votes_gm_email", table_name="votes")
    op.drop_index("ix_ballot_submissions_gm_email", table_name="ballot_submissions")

    # ------------------------------------------------------------------
    # 2. Revert votes FK: CASCADE → SET NULL, NOT NULL → nullable
    # ------------------------------------------------------------------
    op.drop_constraint("fk_votes_lot_owner_id", "votes", type_="foreignkey")
    op.alter_column(
        "votes",
        "lot_owner_id",
        existing_type=sa.UUID(),
        nullable=True,
    )
    op.create_foreign_key(
        "fk_votes_lot_owner_id",
        "votes",
        "lot_owners",
        ["lot_owner_id"],
        ["id"],
        ondelete="SET NULL",
    )
