"""merge proxy and not_eligible branches

Revision ID: e5f6a7b8c9d0
Revises: c8337fb36d23, d1e2f3a4b5c6
Create Date: 2026-03-12 14:00:00.000000

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = ('c8337fb36d23', 'd1e2f3a4b5c6')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
