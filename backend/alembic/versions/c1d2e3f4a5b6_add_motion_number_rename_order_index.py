"""add motion_number rename order_index to display_order

Revision ID: c1d2e3f4a5b6
Revises: a1b2c3d4e5f6
Create Date: 2026-03-25 12:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c1d2e3f4a5b6"
down_revision = "f9a8b7c6d5e4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Rename order_index -> display_order
    op.alter_column("motions", "order_index", new_column_name="display_order")

    # 2. Shift display_order from 0-based to 1-based
    op.execute("UPDATE motions SET display_order = display_order + 1")

    # 3. Drop old unique constraint
    op.drop_constraint("uq_motions_general_meeting_order", "motions", type_="unique")

    # 4. Add new unique constraint on (general_meeting_id, display_order)
    op.create_unique_constraint(
        "uq_motions_general_meeting_display_order",
        "motions",
        ["general_meeting_id", "display_order"],
    )

    # 5. Add motion_number column (VARCHAR NULL)
    op.add_column("motions", sa.Column("motion_number", sa.String(), nullable=True))

    # 6. Add partial unique index on motion_number (excluding NULLs)
    op.execute(
        """
        CREATE UNIQUE INDEX uq_motions_general_meeting_motion_number
        ON motions (general_meeting_id, motion_number)
        WHERE motion_number IS NOT NULL
        """
    )


def downgrade() -> None:
    # Reverse: drop partial index on motion_number
    op.execute("DROP INDEX IF EXISTS uq_motions_general_meeting_motion_number")

    # Drop motion_number column
    op.drop_column("motions", "motion_number")

    # Drop new display_order unique constraint
    op.drop_constraint(
        "uq_motions_general_meeting_display_order", "motions", type_="unique"
    )

    # Restore 0-based display_order values before renaming back
    op.execute("UPDATE motions SET display_order = display_order - 1")

    # Restore old unique constraint on order_index (the old name)
    # We rename AFTER recreating the constraint because the constraint refers to the column
    # First add old constraint under the old column name (we haven't renamed yet)
    op.create_unique_constraint(
        "uq_motions_general_meeting_order",
        "motions",
        ["general_meeting_id", "display_order"],
    )

    # Rename display_order back to order_index
    op.alter_column("motions", "display_order", new_column_name="order_index")
