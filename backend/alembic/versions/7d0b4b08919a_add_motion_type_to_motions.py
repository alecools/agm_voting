"""add motion_type to motions

Revision ID: 7d0b4b08919a
Revises: b3f4a8e91c20
Create Date: 2026-03-12 00:49:43.031023

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7d0b4b08919a'
down_revision: Union[str, Sequence[str], None] = 'b3f4a8e91c20'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    motiontype_enum = sa.Enum('general', 'special', name='motiontype')
    motiontype_enum.create(op.get_bind(), checkfirst=True)
    op.add_column('motions', sa.Column('motion_type', motiontype_enum, server_default='general', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('motions', 'motion_type')
    sa.Enum(name='motiontype').drop(op.get_bind(), checkfirst=True)
