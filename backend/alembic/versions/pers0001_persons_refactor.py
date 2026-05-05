"""persons refactor — normalise identity model

Revision ID: pers0001personsref
Revises: sms0002movephonecontact
Create Date: 2026-05-05 00:00:00.000000

Changes:
  - Create persons table (id UUID PK, email UNIQUE NOT NULL, phone_number, given_name, surname, created_at)
  - Populate persons from lot_owner_emails (dedup by email, oldest-lot name wins)
  - Create lot_persons junction table (lot_id FK→lots, person_id FK→persons, PK composite)
  - Populate lot_persons from lot_owner_emails
  - Add person_id FK to lot_proxies, populate from proxy_email, drop proxy_email/given_name/surname
  - Drop lot_owner_emails table
  - Rename lot_owners → lots (drop given_name, surname columns)
  - Rename lot_owner_id → lot_id in lot_proxies and general_meeting_lot_weights
  - Update FK targets on ballot_submissions and votes to point to lots (column names unchanged)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "pers0001personsref"
down_revision = "sms0002movephonecontact"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Step 1: Create persons table
    # ------------------------------------------------------------------
    op.create_table(
        "persons",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("phone_number", sa.String(20), nullable=True),
        sa.Column("given_name", sa.String(), nullable=True),
        sa.Column("surname", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_persons_email", "persons", ["email"], unique=True)

    # ------------------------------------------------------------------
    # Step 2: Populate persons from lot_owner_emails
    # One row per distinct email; name from oldest lot's email row.
    # ------------------------------------------------------------------
    op.execute("""
        INSERT INTO persons (email, given_name, surname, phone_number)
        SELECT DISTINCT ON (loe.email)
            loe.email,
            loe.given_name,
            loe.surname,
            loe.phone_number
        FROM lot_owner_emails loe
        JOIN lot_owners lo ON loe.lot_owner_id = lo.id
        WHERE loe.email IS NOT NULL
        ORDER BY loe.email, lo.created_at ASC
    """)

    # ------------------------------------------------------------------
    # Step 3: Create lot_persons junction table and populate
    # ------------------------------------------------------------------
    op.create_table(
        "lot_persons",
        sa.Column("lot_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("person_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.ForeignKeyConstraint(["lot_id"], ["lot_owners.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("lot_id", "person_id"),
    )
    op.create_index("ix_lot_persons_person_id", "lot_persons", ["person_id"])

    op.execute("""
        INSERT INTO lot_persons (lot_id, person_id)
        SELECT DISTINCT loe.lot_owner_id, p.id
        FROM lot_owner_emails loe
        JOIN persons p ON loe.email = p.email
        WHERE loe.email IS NOT NULL
    """)

    # ------------------------------------------------------------------
    # Step 4: Add person_id FK to lot_proxies and populate
    # ------------------------------------------------------------------
    op.add_column("lot_proxies", sa.Column(
        "person_id",
        sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=True,
    ))
    op.create_foreign_key(
        "fk_lot_proxies_person_id",
        "lot_proxies", "persons",
        ["person_id"], ["id"],
        ondelete="RESTRICT",
    )

    # Link existing proxies to their persons row
    op.execute("""
        UPDATE lot_proxies lp
        SET person_id = p.id
        FROM persons p
        WHERE lp.proxy_email = p.email
    """)

    # Create new persons rows for proxy emails not yet in persons
    op.execute("""
        INSERT INTO persons (email)
        SELECT DISTINCT proxy_email
        FROM lot_proxies
        WHERE person_id IS NULL
          AND proxy_email IS NOT NULL
    """)

    # Link newly-created persons to the proxies
    op.execute("""
        UPDATE lot_proxies lp
        SET person_id = p.id
        FROM persons p
        WHERE lp.proxy_email = p.email
          AND lp.person_id IS NULL
    """)

    # Make person_id NOT NULL now all rows are populated
    op.alter_column("lot_proxies", "person_id", nullable=False)
    op.create_index("ix_lot_proxies_person_id", "lot_proxies", ["person_id"])

    # ------------------------------------------------------------------
    # Step 5: Drop lot_owner_emails table
    # ------------------------------------------------------------------
    op.drop_table("lot_owner_emails")

    # ------------------------------------------------------------------
    # Step 6: Rename lot_owners → lots and fix FK columns / constraints
    # ------------------------------------------------------------------
    op.rename_table("lot_owners", "lots")

    # Rename constraints on the lots table
    op.execute("ALTER TABLE lots RENAME CONSTRAINT uq_lot_owners_building_lot TO uq_lots_building_lot")
    op.execute("ALTER TABLE lots RENAME CONSTRAINT ck_lot_owners_entitlement_positive TO ck_lots_entitlement_positive")
    op.execute("ALTER TABLE lots RENAME CONSTRAINT ck_lot_owners_lot_number_nonempty TO ck_lots_lot_number_nonempty")

    # Update lot_persons FK now that the table is renamed
    op.drop_constraint("lot_persons_lot_id_fkey", "lot_persons", type_="foreignkey")
    op.create_foreign_key(
        "lot_persons_lot_id_fkey",
        "lot_persons", "lots",
        ["lot_id"], ["id"],
        ondelete="CASCADE",
    )

    # Rename lot_owner_id → lot_id in lot_proxies
    op.alter_column("lot_proxies", "lot_owner_id", new_column_name="lot_id")
    # Rename the unique constraint on lot_proxies
    op.execute("ALTER TABLE lot_proxies RENAME CONSTRAINT uq_lot_proxies_lot_owner_id TO uq_lot_proxies_lot_id")
    # Update FK reference to use the renamed table
    op.drop_constraint("lot_proxies_lot_owner_id_fkey", "lot_proxies", type_="foreignkey")
    op.create_foreign_key(
        "lot_proxies_lot_id_fkey",
        "lot_proxies", "lots",
        ["lot_id"], ["id"],
        ondelete="CASCADE",
    )

    # Rename lot_owner_id → lot_id in general_meeting_lot_weights
    op.alter_column("general_meeting_lot_weights", "lot_owner_id", new_column_name="lot_id")
    op.drop_constraint("agm_lot_weights_lot_owner_id_fkey", "general_meeting_lot_weights", type_="foreignkey")
    op.create_foreign_key(
        "general_meeting_lot_weights_lot_id_fkey",
        "general_meeting_lot_weights", "lots",
        ["lot_id"], ["id"],
        ondelete="CASCADE",
    )

    # Update FK targets on ballot_submissions and votes — column names unchanged
    op.drop_constraint("fk_ballot_submissions_lot_owner_id", "ballot_submissions", type_="foreignkey")
    op.create_foreign_key(
        "fk_ballot_submissions_lot_owner_id",
        "ballot_submissions", "lots",
        ["lot_owner_id"], ["id"],
    )

    op.drop_constraint("fk_votes_lot_owner_id", "votes", type_="foreignkey")
    op.create_foreign_key(
        "fk_votes_lot_owner_id",
        "votes", "lots",
        ["lot_owner_id"], ["id"],
    )

    # ------------------------------------------------------------------
    # Step 7: Drop given_name, surname from lots
    # ------------------------------------------------------------------
    op.drop_column("lots", "given_name")
    op.drop_column("lots", "surname")

    # ------------------------------------------------------------------
    # Step 8: Drop proxy_email, given_name, surname from lot_proxies
    # ------------------------------------------------------------------
    op.drop_index("ix_lot_proxies_proxy_email", table_name="lot_proxies")
    op.drop_column("lot_proxies", "proxy_email")
    op.drop_column("lot_proxies", "given_name")
    op.drop_column("lot_proxies", "surname")


def downgrade() -> None:
    # Downgrade is complex — restore the full pre-refactor schema.
    # This restores structure but cannot restore deleted data (persons / lot_persons).

    # Step 8 reverse: add proxy_email, given_name, surname back to lot_proxies
    op.add_column("lot_proxies", sa.Column("proxy_email", sa.String(), nullable=True))
    op.add_column("lot_proxies", sa.Column("given_name", sa.String(), nullable=True))
    op.add_column("lot_proxies", sa.Column("surname", sa.String(), nullable=True))

    # Step 7 reverse: add given_name, surname back to lots
    op.add_column("lots", sa.Column("given_name", sa.String(), nullable=True))
    op.add_column("lots", sa.Column("surname", sa.String(), nullable=True))

    # Step 6 reverse: restore lot_owners FK references and rename back
    op.drop_constraint("fk_votes_lot_owner_id", "votes", type_="foreignkey")
    op.create_foreign_key(
        "fk_votes_lot_owner_id",
        "votes", "lots",
        ["lot_owner_id"], ["id"],
    )

    op.drop_constraint("fk_ballot_submissions_lot_owner_id", "ballot_submissions", type_="foreignkey")
    op.create_foreign_key(
        "fk_ballot_submissions_lot_owner_id",
        "ballot_submissions", "lots",
        ["lot_owner_id"], ["id"],
    )

    # Rename lot_id back to lot_owner_id in general_meeting_lot_weights
    op.drop_constraint("general_meeting_lot_weights_lot_id_fkey", "general_meeting_lot_weights", type_="foreignkey")
    op.alter_column("general_meeting_lot_weights", "lot_id", new_column_name="lot_owner_id")
    op.create_foreign_key(
        "agm_lot_weights_lot_owner_id_fkey",
        "general_meeting_lot_weights", "lots",
        ["lot_owner_id"], ["id"],
        ondelete="CASCADE",
    )

    # Rename lot_id back to lot_owner_id in lot_proxies
    op.drop_constraint("lot_proxies_lot_id_fkey", "lot_proxies", type_="foreignkey")
    op.execute("ALTER TABLE lot_proxies RENAME CONSTRAINT uq_lot_proxies_lot_id TO uq_lot_proxies_lot_owner_id")
    op.alter_column("lot_proxies", "lot_id", new_column_name="lot_owner_id")
    op.create_foreign_key(
        "lot_proxies_lot_owner_id_fkey",
        "lot_proxies", "lots",
        ["lot_owner_id"], ["id"],
        ondelete="CASCADE",
    )

    # Update lot_persons FK to reference lots (still named lots at this point)
    op.drop_constraint("lot_persons_lot_id_fkey", "lot_persons", type_="foreignkey")
    op.create_foreign_key(
        "lot_persons_lot_id_fkey",
        "lot_persons", "lots",
        ["lot_id"], ["id"],
        ondelete="CASCADE",
    )

    # Rename lots back to lot_owners
    op.execute("ALTER TABLE lots RENAME CONSTRAINT uq_lots_building_lot TO uq_lot_owners_building_lot")
    op.execute("ALTER TABLE lots RENAME CONSTRAINT ck_lots_entitlement_positive TO ck_lot_owners_entitlement_positive")
    op.execute("ALTER TABLE lots RENAME CONSTRAINT ck_lots_lot_number_nonempty TO ck_lot_owners_lot_number_nonempty")
    op.rename_table("lots", "lot_owners")

    # Restore lot_owner_emails proxy_email index
    op.create_index("ix_lot_proxies_proxy_email", "lot_proxies", ["proxy_email"])

    # Step 5 reverse: recreate lot_owner_emails (empty — data is lost)
    op.create_table(
        "lot_owner_emails",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("lot_owner_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("given_name", sa.String(), nullable=True),
        sa.Column("surname", sa.String(), nullable=True),
        sa.Column("phone_number", sa.String(20), nullable=True),
        sa.ForeignKeyConstraint(["lot_owner_id"], ["lot_owners.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("lot_owner_id", "email", name="uq_lot_owner_emails_owner_email"),
    )
    op.create_index("ix_lot_owner_emails_email", "lot_owner_emails", ["email"])

    # Step 4 reverse: drop person_id from lot_proxies
    op.drop_index("ix_lot_proxies_person_id", "lot_proxies")
    op.drop_constraint("fk_lot_proxies_person_id", "lot_proxies", type_="foreignkey")
    op.drop_column("lot_proxies", "person_id")

    # Step 3 reverse: drop lot_persons
    op.drop_index("ix_lot_persons_person_id", "lot_persons")
    op.drop_table("lot_persons")

    # Step 1+2 reverse: drop persons
    op.drop_index("ix_persons_email", "persons")
    op.drop_table("persons")
