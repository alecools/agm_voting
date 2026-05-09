"""add_otp_channel_toggles

Revision ID: d3b931f49d21
Revises: rr7002adminuserid
Create Date: 2026-05-09 20:36:38.502452

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd3b931f49d21'
down_revision: Union[str, Sequence[str], None] = 'rr7002adminuserid'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add otp_email_enabled and otp_sms_enabled columns to tenant_config."""
    op.add_column(
        'tenant_config',
        sa.Column(
            'otp_email_enabled',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('true'),
        ),
    )
    op.add_column(
        'tenant_config',
        sa.Column(
            'otp_sms_enabled',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('false'),
        ),
    )


def downgrade() -> None:
    """Remove otp_email_enabled and otp_sms_enabled columns from tenant_config."""
    op.drop_column('tenant_config', 'otp_sms_enabled')
    op.drop_column('tenant_config', 'otp_email_enabled')
