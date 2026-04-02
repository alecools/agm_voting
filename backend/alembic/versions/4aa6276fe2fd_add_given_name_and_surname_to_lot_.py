"""add given_name and surname to lot_owners and lot_proxies

Revision ID: 4aa6276fe2fd
Revises: 3869c4d28305
Create Date: 2026-04-02 18:56:45.242589

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4aa6276fe2fd'
down_revision: Union[str, Sequence[str], None] = '3869c4d28305'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('lot_owners', sa.Column('given_name', sa.String(), nullable=True))
    op.add_column('lot_owners', sa.Column('surname', sa.String(), nullable=True))
    op.add_column('lot_proxies', sa.Column('given_name', sa.String(), nullable=True))
    op.add_column('lot_proxies', sa.Column('surname', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('lot_proxies', 'surname')
    op.drop_column('lot_proxies', 'given_name')
    op.drop_column('lot_owners', 'surname')
    op.drop_column('lot_owners', 'given_name')
