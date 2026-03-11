"""add_archive_columns

Revision ID: b3f4a8e91c20
Revises: dcb854233f78
Create Date: 2026-03-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3f4a8e91c20'
down_revision: Union[str, Sequence[str], None] = 'dcb854233f78'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('buildings', sa.Column('is_archived', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('lot_owners', sa.Column('is_archived', sa.Boolean(), nullable=False, server_default='false'))


def downgrade() -> None:
    op.drop_column('buildings', 'is_archived')
    op.drop_column('lot_owners', 'is_archived')
