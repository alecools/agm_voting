"""add voting_closed_at to motions

Revision ID: 999371be8368
Revises: aec6a1bb5035
Create Date: 2026-04-02 18:57:40.609702

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '999371be8368'
down_revision: Union[str, Sequence[str], None] = '4aa6276fe2fd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "motions",
        sa.Column("voting_closed_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("motions", "voting_closed_at")
