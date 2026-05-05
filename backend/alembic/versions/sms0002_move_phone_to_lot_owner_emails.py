"""move phone_number from lot_owners to lot_owner_emails

Revision ID: sms0002movephonecontact
Revises: sms0001smsotp
Create Date: 2026-05-04 00:00:00.000000

Changes:
  1. Add lot_owner_emails.phone_number VARCHAR(20) NULL
  2. Copy existing data: UPDATE lot_owner_emails SET phone_number = lot_owners.phone_number
  3. Drop lot_owners.phone_number
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "sms0002movephonecontact"
down_revision = "sms0001smsotp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Step 1: Add phone_number to lot_owner_emails
    op.add_column(
        "lot_owner_emails",
        sa.Column("phone_number", sa.String(20), nullable=True),
    )

    # Step 2: Copy data from lot_owners.phone_number to lot_owner_emails.phone_number
    # Each lot owner may have multiple email rows; we copy the phone to every email row
    # belonging to that lot owner.
    op.execute(
        """
        UPDATE lot_owner_emails loe
        SET phone_number = lo.phone_number
        FROM lot_owners lo
        WHERE loe.lot_owner_id = lo.id
          AND lo.phone_number IS NOT NULL
        """
    )

    # Step 3: Drop phone_number from lot_owners
    op.drop_column("lot_owners", "phone_number")


def downgrade() -> None:
    # Restore phone_number on lot_owners
    op.add_column(
        "lot_owners",
        sa.Column("phone_number", sa.String(20), nullable=True),
    )

    # Copy back: take first non-null phone from any email row
    op.execute(
        """
        UPDATE lot_owners lo
        SET phone_number = (
            SELECT loe.phone_number
            FROM lot_owner_emails loe
            WHERE loe.lot_owner_id = lo.id
              AND loe.phone_number IS NOT NULL
            ORDER BY loe.id
            LIMIT 1
        )
        WHERE EXISTS (
            SELECT 1 FROM lot_owner_emails loe
            WHERE loe.lot_owner_id = lo.id
              AND loe.phone_number IS NOT NULL
        )
        """
    )

    # Drop phone_number from lot_owner_emails
    op.drop_column("lot_owner_emails", "phone_number")
