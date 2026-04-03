"""add_for_against_abstained_tallies_to_motion_options

Revision ID: 091424401a0b
Revises: a9c1d5e7f2b3
Create Date: 2026-04-03 12:17:54.943593

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '091424401a0b'
down_revision: Union[str, Sequence[str], None] = 'smtp0001smtp0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add For/Against/Abstained tally snapshot columns to motion_options."""
    op.add_column('motion_options', sa.Column('for_voter_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('motion_options', sa.Column('for_entitlement_sum', sa.Numeric(), nullable=False, server_default='0'))
    op.add_column('motion_options', sa.Column('against_voter_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('motion_options', sa.Column('against_entitlement_sum', sa.Numeric(), nullable=False, server_default='0'))
    op.add_column('motion_options', sa.Column('abstained_voter_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('motion_options', sa.Column('abstained_entitlement_sum', sa.Numeric(), nullable=False, server_default='0'))


def downgrade() -> None:
    """Remove For/Against/Abstained tally snapshot columns from motion_options."""
    op.drop_column('motion_options', 'abstained_entitlement_sum')
    op.drop_column('motion_options', 'abstained_voter_count')
    op.drop_column('motion_options', 'against_entitlement_sum')
    op.drop_column('motion_options', 'against_voter_count')
    op.drop_column('motion_options', 'for_entitlement_sum')
    op.drop_column('motion_options', 'for_voter_count')
