"""add_not_eligible_to_votechoice

Revision ID: d1e2f3a4b5c6
Revises: a1b2c3d4e5f6
Create Date: 2026-03-12 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'd1e2f3a4b5c6'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add 'not_eligible' value to the votechoice enum.

    ALTER TYPE ... ADD VALUE cannot run inside a transaction, so this
    migration uses a non-transactional connection via execute_if / raw SQL.
    The Alembic migration context must be configured without a transaction
    for this statement to succeed on PostgreSQL.
    """
    op.execute("COMMIT")
    op.execute("ALTER TYPE votechoice ADD VALUE IF NOT EXISTS 'not_eligible'")


def downgrade() -> None:
    """Downgrade: removing an enum value from PostgreSQL is not supported natively.

    The safest approach is to convert any not_eligible votes to abstained,
    then recreate the enum without the value. However, since PostgreSQL
    does not support DROP VALUE on enums, downgrade is a no-op here to
    avoid data loss. If a full rollback is needed, the database must be
    restored from a backup.
    """
    # PostgreSQL does not support removing enum values.
    # Convert any not_eligible votes to abstained before removing is impossible
    # without recreating the type. Accept this as a no-op downgrade.
    pass
