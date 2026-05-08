"""add_submitted_by_admin_user_id

Revision ID: rr7002adminuserid
Revises: rr7001compoundvotes
Create Date: 2026-05-08 00:00:00.000000

Changes:
  Add nullable column submitted_by_admin_user_id VARCHAR(255) to ballot_submissions.
  submitted_by_admin_username is retained for backward compatibility.
  The new column stores the immutable user ID (not the mutable username/email)
  to preserve the audit link even after admin rename or deletion.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "rr7002adminuserid"
down_revision: Union[str, Sequence[str], None] = "rr7001compoundvotes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ballot_submissions",
        sa.Column(
            "submitted_by_admin_user_id",
            sa.String(255),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("ballot_submissions", "submitted_by_admin_user_id")
