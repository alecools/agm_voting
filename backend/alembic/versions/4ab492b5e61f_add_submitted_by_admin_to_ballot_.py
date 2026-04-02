"""add submitted_by_admin to ballot_submissions

Revision ID: 4ab492b5e61f
Revises: aec6a1bb5035
Create Date: 2026-04-02 19:05:50.452852

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4ab492b5e61f'
down_revision: Union[str, Sequence[str], None] = '999371be8368'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('ballot_submissions', sa.Column('submitted_by_admin', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('ballot_submissions', 'submitted_by_admin')
