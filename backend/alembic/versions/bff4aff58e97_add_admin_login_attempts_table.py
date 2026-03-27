"""add_admin_login_attempts_table

Revision ID: bff4aff58e97
Revises: 888085a72643
Create Date: 2026-03-27 09:46:48.233271

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'bff4aff58e97'
down_revision: Union[str, Sequence[str], None] = '888085a72643'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'admin_login_attempts',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('ip_address', sa.String(), nullable=False),
        sa.Column('failed_count', sa.Integer(), nullable=False),
        sa.Column('first_attempt_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_attempt_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_admin_login_attempts_ip', 'admin_login_attempts', ['ip_address'], unique=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_admin_login_attempts_ip', table_name='admin_login_attempts')
    op.drop_table('admin_login_attempts')
