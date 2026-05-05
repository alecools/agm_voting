# Design: Building and Lot Management

PRD reference: `tasks/prd/prd-buildings-and-lots.md`

**Status:** Implemented

---

## Overview

Admins manage buildings and their lot owners. This design covers the full lifecycle: building CRUD, lot owner CRUD, bulk import, financial positions, proxy nominations, and owner names.

The **persons refactor** (US-PERS-01) replaces the per-lot, per-email identity model with a normalised `persons` table. Phone number, email address, and name are stored once per real-world person and shared across all lots they own or proxy for. This eliminates data duplication and inconsistency that occurs when one person owns multiple lots (or proxies multiple lots) and has to be updated in multiple places.

---

## Root Cause / Background

Buildings are the top-level organisational unit. Each building has many lot owners, each of which may vote in an AGM. Multi-email support accommodates co-owners. Optional emails allow estate-managed lots with no known email. Financial position tracking determines vote eligibility on General Motions.

The current model stores `(given_name, surname)` on `lot_owners` and on each `lot_owner_emails` row, and `(proxy_email, given_name, surname)` inline on `lot_proxies`. This means a person who owns three lots has their name stored three times; a proxy who represents five lots has their email and name stored five times. Any update to a name or phone number requires updating all rows.

---

## Technical Design

### Database changes — current schema (pre-refactor)

| Table | Key columns |
|---|---|
| `lot_owners` | `id` PK, `building_id` FK, `lot_number`, `unit_entitlement`, `financial_position` enum, `given_name`, `surname`, `is_archived`, `created_at`, `updated_at` |
| `lot_owner_emails` | `id` PK, `lot_owner_id` FK→`lot_owners`, `email`, `given_name`, `surname`, `phone_number` |
| `lot_proxies` | `id` PK, `lot_owner_id` FK→`lot_owners` UNIQUE, `proxy_email`, `given_name`, `surname`, `created_at` |

### Database changes — target schema (post-refactor)

#### New table: `persons`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID PK | default `uuid_generate_v4()` |
| `email` | VARCHAR | NOT NULL, UNIQUE |
| `phone_number` | VARCHAR(20) | nullable |
| `given_name` | VARCHAR | nullable |
| `surname` | VARCHAR | nullable |
| `created_at` | TIMESTAMPTZ | NOT NULL, `server_default=now()` |

Indexes: `ix_persons_email` on `email` (unique index, serves FK lookups and auth queries).

#### Renamed table: `lot_owners` → `lots`

The `lot_owners` table is renamed to `lots`. The Python class is renamed from `LotOwner` to `Lot`. This is a user-directed decision for domain clarity.

All FK columns that referenced `lot_owners.id` must also be renamed in the same migration:

| Table | Old column | New column | Notes |
|---|---|---|---|
| `lot_proxies` | `lot_owner_id` | `lot_id` | Renamed to match the table rename |
| `general_meeting_lot_weights` | `lot_owner_id` | `lot_id` | Renamed to match the table rename |
| `ballot_submissions` | `lot_owner_id` | **left as `lot_owner_id`** | Audit column — intentionally not renamed in this PR (see Risks section) |
| `votes` | `lot_owner_id` | **left as `lot_owner_id`** | Audit column — intentionally not renamed in this PR (see Risks section) |

Columns removed from `lots` (renamed from `lot_owners`):
- `given_name` — moved to `persons`
- `surname` — moved to `persons`

Columns retained on `lots`:
- `id`, `building_id`, `lot_number`, `unit_entitlement`, `financial_position`, `is_archived`, `created_at`, `updated_at`

Constraints renamed to match new table name:
- `uq_lot_owners_building_lot` → `uq_lots_building_lot`
- `ck_lot_owners_entitlement_positive` → `ck_lots_entitlement_positive`
- `ck_lot_owners_lot_number_nonempty` → `ck_lots_lot_number_nonempty`

#### New table: `lot_persons` (replaces `lot_owner_emails`)

| Column | Type | Constraints |
|---|---|---|
| `lot_id` | UUID FK → `lots.id` ON DELETE CASCADE | NOT NULL |
| `person_id` | UUID FK → `persons.id` ON DELETE RESTRICT | NOT NULL |
| PRIMARY KEY | `(lot_id, person_id)` | |

`ON DELETE RESTRICT` on `person_id` prevents deleting a person who still owns a lot. Persons are never automatically deleted.

Indexes: `ix_lot_persons_person_id` on `person_id` (for reverse lookup: "which lots does this person own?").

**Why `lot_owner_emails` is dropped:** The old table stored `(lot_owner_id, email, given_name, surname, phone_number)`. That is now split: email/name/phone on `persons`, the join on `lot_persons`.

#### Modified table: `lot_proxies`

Remove columns: `proxy_email`, `given_name`, `surname`.
Rename column: `lot_owner_id` → `lot_id`.
Add column: `person_id` UUID FK → `persons.id` ON DELETE RESTRICT.

New shape:

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID PK | |
| `lot_id` | UUID FK → `lots.id` ON DELETE CASCADE | NOT NULL |
| `person_id` | UUID FK → `persons.id` ON DELETE RESTRICT | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL |

Unique constraint renamed: `uq_lot_proxies_lot_owner_id` → `uq_lot_proxies_lot_id` (one proxy per lot).
Index renamed: `ix_lot_proxies_proxy_email` → `ix_lot_proxies_person_id` on `person_id`.

#### Modified table: `general_meeting_lot_weights`

Rename column: `lot_owner_id` → `lot_id`.

Unique constraint renamed: `uq_general_meeting_lot_weights_gm_lot` → `uq_general_meeting_lot_weights_gm_lot` (name unchanged — no explicit rename needed unless the implementation prefers it for clarity).

FK updated to reference `lots.id` (was `lot_owners.id`).

#### Tables with intentionally unchanged `lot_owner_id` columns

The following tables retain `lot_owner_id` in this PR. The FK target changes from `lot_owners.id` to `lots.id` (because the table is renamed, not dropped), but the column name is left as `lot_owner_id` intentionally:

- `ballot_submissions.lot_owner_id` — audit column; cosmetic rename is a separate future PR
- `votes.lot_owner_id` — audit column; cosmetic rename is a separate future PR

The FKs on these columns must be updated to reference `lots.id` (the renamed table), but the column names do not change. This is handled in the migration by dropping and re-adding the FK constraints with the updated `REFERENCES lots(id)` target.

### Migration strategy — single Alembic revision, backward-compatible

The migration is a multi-step data transformation inside one Alembic revision. No step drops a column until all data has been migrated. The steps are:

**Step 1: Create `persons` table**
```sql
CREATE TABLE persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR NOT NULL,
    phone_number VARCHAR(20),
    given_name VARCHAR,
    surname VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ix_persons_email ON persons (email);
```

**Step 2: Populate `persons` from `lot_owner_emails`**

Dedup by email — one person row per distinct email. Name resolution rule: for each distinct email, pick the `given_name` and `surname` from the `lot_owner_emails` row that corresponds to the `lot_owners` row with the lowest `created_at` (i.e. the oldest lot that has this email). Phone is taken from the first `lot_owner_emails` row with a non-null `phone_number` for that email. If two `lot_owners` rows share the same email but have different names, the oldest lot's name wins — this is the "first-created lot" rule. The rationale is that the first entry is most likely the canonical record; subsequent imports may have introduced variations.

```sql
INSERT INTO persons (email, given_name, surname, phone_number)
SELECT DISTINCT ON (loe.email)
    loe.email,
    loe.given_name,
    loe.surname,
    loe.phone_number
FROM lot_owner_emails loe
JOIN lot_owners lo ON loe.lot_owner_id = lo.id
WHERE loe.email IS NOT NULL
ORDER BY loe.email, lo.created_at ASC;
```

**Step 3: Create `lot_persons` table and populate from `lot_owner_emails`**
```sql
CREATE TABLE lot_persons (
    lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    PRIMARY KEY (lot_id, person_id)
);
CREATE INDEX ix_lot_persons_person_id ON lot_persons (person_id);

INSERT INTO lot_persons (lot_id, person_id)
SELECT DISTINCT loe.lot_owner_id, p.id
FROM lot_owner_emails loe
JOIN persons p ON loe.email = p.email
WHERE loe.email IS NOT NULL;
```

**Step 4: Add `person_id` FK to `lot_proxies`, populate**

First, add the column as nullable (allows rows that have no match during population):
```sql
ALTER TABLE lot_proxies ADD COLUMN person_id UUID REFERENCES persons(id) ON DELETE RESTRICT;

-- Populate person_id for proxies where proxy_email already in persons
UPDATE lot_proxies lp
SET person_id = p.id
FROM persons p
WHERE lp.proxy_email = p.email;

-- Create new persons rows for proxy emails not yet in persons (NULL name, NULL phone)
INSERT INTO persons (email)
SELECT DISTINCT proxy_email
FROM lot_proxies
WHERE person_id IS NULL
  AND proxy_email IS NOT NULL;

-- Now link those newly-created persons
UPDATE lot_proxies lp
SET person_id = p.id
FROM persons p
WHERE lp.proxy_email = p.email
  AND lp.person_id IS NULL;

-- Add NOT NULL constraint now that all rows are populated
ALTER TABLE lot_proxies ALTER COLUMN person_id SET NOT NULL;
CREATE INDEX ix_lot_proxies_person_id ON lot_proxies (person_id);
```

**Step 5: Drop `lot_owner_emails` table**
```sql
DROP TABLE lot_owner_emails;
```

**Step 6: Rename `lot_owners` → `lots` and rename FK columns**
```sql
-- Rename the table
ALTER TABLE lot_owners RENAME TO lots;

-- Rename the unique constraint and check constraints
ALTER TABLE lots RENAME CONSTRAINT uq_lot_owners_building_lot TO uq_lots_building_lot;
ALTER TABLE lots RENAME CONSTRAINT ck_lot_owners_entitlement_positive TO ck_lots_entitlement_positive;
ALTER TABLE lots RENAME CONSTRAINT ck_lot_owners_lot_number_nonempty TO ck_lots_lot_number_nonempty;

-- Rename FK column in lot_proxies (lot_owner_id → lot_id)
ALTER TABLE lot_proxies RENAME COLUMN lot_owner_id TO lot_id;
ALTER TABLE lot_proxies RENAME CONSTRAINT uq_lot_proxies_lot_owner_id TO uq_lot_proxies_lot_id;

-- Rename FK column in general_meeting_lot_weights (lot_owner_id → lot_id)
ALTER TABLE general_meeting_lot_weights RENAME COLUMN lot_owner_id TO lot_id;

-- Update FK targets on ballot_submissions and votes to point to renamed table
-- Column names are intentionally left as lot_owner_id (audit columns — separate cleanup PR)
ALTER TABLE ballot_submissions
    DROP CONSTRAINT ballot_submissions_lot_owner_id_fkey,
    ADD CONSTRAINT ballot_submissions_lot_owner_id_fkey
        FOREIGN KEY (lot_owner_id) REFERENCES lots(id);

ALTER TABLE votes
    DROP CONSTRAINT votes_lot_owner_id_fkey,
    ADD CONSTRAINT votes_lot_owner_id_fkey
        FOREIGN KEY (lot_owner_id) REFERENCES lots(id);
```

**Step 7: Drop `given_name`, `surname` from `lots`**
```sql
ALTER TABLE lots DROP COLUMN given_name;
ALTER TABLE lots DROP COLUMN surname;
```

**Step 8: Drop `proxy_email`, `given_name`, `surname` from `lot_proxies`**
```sql
ALTER TABLE lot_proxies DROP COLUMN proxy_email;
ALTER TABLE lot_proxies DROP COLUMN given_name;
ALTER TABLE lot_proxies DROP COLUMN surname;
```

**Edge cases handled:**
- Lots with no email in `lot_owner_emails`: skip person creation, leave lot with no `lot_persons` row.
- Two `lot_owners` sharing same email with different names: the oldest lot's name is used (first-created rule, documented above).
- `proxy_email` not in `persons` after Step 2: a new `persons` row is created with `NULL` given_name and `NULL` surname (Step 4).
- `proxy_email IS NULL` in `lot_proxies`: this violates the existing `NOT NULL` constraint on `proxy_email`, so no null proxies can exist; no special handling needed.

### SQLAlchemy model changes

**New model: `Person`** (`backend/app/models/person.py`)

```python
class Person(Base):
    __tablename__ = "persons"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    given_name: Mapped[str | None] = mapped_column(String, nullable=True)
    surname: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    lots: Mapped[list["Lot"]] = relationship(
        "Lot", secondary="lot_persons", back_populates="persons"
    )
    proxied_lots: Mapped[list["LotProxy"]] = relationship(
        "LotProxy", back_populates="person"
    )
```

**New association table: `lot_persons`** (`backend/app/models/lot_person.py`)

```python
from sqlalchemy import ForeignKey, Table, Column, Index
from app.models.base import Base

lot_persons = Table(
    "lot_persons",
    Base.metadata,
    Column("lot_id", ForeignKey("lots.id", ondelete="CASCADE"), primary_key=True),
    Column("person_id", ForeignKey("persons.id", ondelete="RESTRICT"), primary_key=True),
    Index("ix_lot_persons_person_id", "person_id"),
)
```

**Renamed model: `Lot`** (was `LotOwner`) (`backend/app/models/lot.py`, renamed from `lot_owner.py`) — `__tablename__ = "lots"`, remove `given_name`, `surname`, add `persons` M2M relationship:

```python
class Lot(Base):
    __tablename__ = "lots"
    # ... existing columns (id, building_id, lot_number, unit_entitlement,
    #     financial_position, is_archived, created_at, updated_at) unchanged ...

    persons: Mapped[list["Person"]] = relationship(
        "Person", secondary="lot_persons", back_populates="lots"
    )
```

**Modified model: `LotProxy`** — remove `proxy_email`, `given_name`, `surname`; rename `lot_owner_id` → `lot_id`; add `person_id` FK and `person` relationship:

```python
lot_id: Mapped[uuid.UUID] = mapped_column(
    ForeignKey("lots.id", ondelete="CASCADE"), nullable=False, unique=True
)
person_id: Mapped[uuid.UUID] = mapped_column(
    ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False
)
person: Mapped["Person"] = relationship("Person", back_populates="proxied_lots")
```

### Pydantic schema changes

#### New schema: `PersonOut`

```python
class PersonOut(BaseModel):
    id: uuid.UUID
    email: str
    given_name: str | None = None
    surname: str | None = None
    phone_number: str | None = None
    model_config = {"from_attributes": True}
```

#### Updated schema: `LotOwnerOut`

**Before:**
```python
class LotOwnerOut(BaseModel):
    id: uuid.UUID
    lot_number: str
    given_name: str | None = None          # removed
    surname: str | None = None             # removed
    owner_emails: list[LotOwnerEmailOut]   # replaced by persons
    unit_entitlement: int
    financial_position: str
    proxy_email: str | None = None
    proxy_given_name: str | None = None
    proxy_surname: str | None = None
```

**After:**
```python
class LotOwnerOut(BaseModel):
    id: uuid.UUID
    lot_number: str
    persons: list[PersonOut] = []          # replaces owner_emails
    unit_entitlement: int
    financial_position: str
    proxy_email: str | None = None         # kept: person.email from lot_proxies → person
    proxy_given_name: str | None = None    # kept: person.given_name
    proxy_surname: str | None = None       # kept: person.surname

    model_config = {"from_attributes": True}

    @computed_field
    @property
    def emails(self) -> list[str]:
        """Backward-compatible flat list of email strings."""
        return [p.email for p in self.persons]

    @computed_field
    @property
    def owner_emails(self) -> list[dict]:
        """Backward-compatible list using PersonOut structure."""
        return [{"id": str(p.id), "email": p.email, "given_name": p.given_name,
                 "surname": p.surname, "phone_number": p.phone_number} for p in self.persons]
```

#### Removed schema: `LotOwnerEmailOut`

Replaced by `PersonOut`. The `owner_emails` computed field above produces a structurally equivalent dict list for backward compatibility.

#### Updated schema: `LotOwnerCreate`

Remove `given_name`, `surname` from the request body — name and phone are now on the person, not the lot. When creating a lot with an email, the service resolves or creates the person.

**Before:**
```python
class LotOwnerCreate(BaseModel):
    lot_number: str
    given_name: str | None = None
    surname: str | None = None
    unit_entitlement: int
    financial_position: str = "normal"
    emails: list[str] = []
```

**After:**
```python
class LotOwnerCreate(BaseModel):
    lot_number: str
    unit_entitlement: int
    financial_position: str = "normal"
    emails: list[str] = []         # kept: plain email strings; person lookup happens in service
```

#### Updated schema: `LotOwnerUpdate`

Remove `given_name`, `surname` — admins who want to update a person's name now do so through the person-level endpoint (see below).

**Before:**
```python
class LotOwnerUpdate(BaseModel):
    given_name: str | None = None
    surname: str | None = None
    unit_entitlement: int | None = None
    financial_position: str | None = None
```

**After:**
```python
class LotOwnerUpdate(BaseModel):
    unit_entitlement: int | None = None
    financial_position: str | None = None
```

#### Updated schema: `AddOwnerEmailRequest`

Remove `given_name`, `surname` from adding an email to a lot. The service creates or looks up the person by email; name comes from the person row.

**Before:**
```python
class AddOwnerEmailRequest(BaseModel):
    email: str
    given_name: str | None = None
    surname: str | None = None
    phone_number: str | None = None
```

**After:**
```python
class AddOwnerEmailRequest(BaseModel):
    email: str                            # person looked up or created by email
    # name/phone now come from persons row; not set inline
```

#### Updated schema: `UpdateOwnerEmailRequest` → renamed `UpdatePersonRequest`

When an admin "edits" an owner-email entry, they are editing the person. The endpoint target changes from `owner-emails/{email_id}` to `persons/{person_id}`.

```python
class UpdatePersonRequest(BaseModel):
    email: str | None = None
    given_name: str | None = None
    surname: str | None = None
    phone_number: str | None = None
```

#### Updated schema: `SetProxyRequest`

Remove `given_name`, `surname` — proxy name comes from the persons row.

**Before:**
```python
class SetProxyRequest(BaseModel):
    proxy_email: str
    given_name: str | None = None
    surname: str | None = None
```

**After:**
```python
class SetProxyRequest(BaseModel):
    proxy_email: str    # service resolves or creates person by email
```

### API endpoint changes — exact before/after shapes

#### `GET /api/admin/buildings/{id}/lot-owners` and `GET /api/admin/lot-owners/{lot_owner_id}`

**Before response (per lot):**
```json
{
  "id": "uuid",
  "lot_number": "1A",
  "given_name": "Alice",
  "surname": "Smith",
  "owner_emails": [
    {"id": "uuid", "email": "alice@example.com", "given_name": "Alice",
     "surname": "Smith", "phone_number": "+61412345678"}
  ],
  "emails": ["alice@example.com"],
  "unit_entitlement": 100,
  "financial_position": "normal",
  "proxy_email": null,
  "proxy_given_name": null,
  "proxy_surname": null
}
```

**After response (per lot):**
```json
{
  "id": "uuid",
  "lot_number": "1A",
  "persons": [
    {"id": "uuid", "email": "alice@example.com", "given_name": "Alice",
     "surname": "Smith", "phone_number": "+61412345678"}
  ],
  "emails": ["alice@example.com"],
  "owner_emails": [
    {"id": "uuid", "email": "alice@example.com", "given_name": "Alice",
     "surname": "Smith", "phone_number": "+61412345678"}
  ],
  "unit_entitlement": 100,
  "financial_position": "normal",
  "proxy_email": null,
  "proxy_given_name": null,
  "proxy_surname": null
}
```

Note: `given_name` and `surname` are removed from the top-level lot object. `emails` and `owner_emails` are retained as backward-compatible computed fields. `persons` is the new canonical list.

#### `POST /api/admin/lot-owners/{id}/owner-emails`

**Before request:**
```json
{"email": "alice@example.com", "given_name": "Alice", "surname": "Smith", "phone_number": "+61412345678"}
```

**After request:**
```json
{"email": "alice@example.com"}
```

The service looks up `persons` by email. If found, links the existing person to the lot. If not found, creates a new `persons` row with only email set (name/phone must be set separately via `PATCH /api/admin/persons/{person_id}`).

Response shape: `LotOwnerOut` (same as GET).

#### `PATCH /api/admin/lot-owners/{id}/owner-emails/{email_id}` → **replaced** by `PATCH /api/admin/persons/{person_id}`

The old endpoint patched fields on a `lot_owner_emails` row. The new endpoint patches fields on the `persons` row directly.

**New endpoint:** `PATCH /api/admin/persons/{person_id}`

Request:
```json
{"email": "alice@example.com", "given_name": "Alice", "surname": "Smith", "phone_number": "+61412345678"}
```

Response: `PersonOut`
```json
{"id": "uuid", "email": "alice@example.com", "given_name": "Alice", "surname": "Smith", "phone_number": "+61412345678"}
```

Returns 404 if person not found. Returns 409 if new email conflicts with another existing person.

#### `DELETE /api/admin/lot-owners/{id}/owner-emails/{email_id}` → **replaced** by `DELETE /api/admin/lot-owners/{id}/persons/{person_id}`

Removes the `lot_persons` join row. The `persons` row is **not deleted** (it may be linked to other lots or proxies).

Response: `LotOwnerOut` (updated lot without this person).
Returns 404 if join row not found.

#### `PUT /api/admin/lot-owners/{id}/proxy`

**Before request:**
```json
{"proxy_email": "proxy@example.com", "given_name": "Bob", "surname": "Jones"}
```

**After request:**
```json
{"proxy_email": "proxy@example.com"}
```

Service resolves/creates person by email. Name comes from the persons row. If person exists but has no name, name stays null until explicitly set via `PATCH /api/admin/persons/{person_id}`.

Response: `LotOwnerOut` (proxy fields populated from persons row).

#### `DELETE /api/admin/lot-owners/{id}/proxy`

No change in request/response shape. Deletes the `lot_proxies` row; does not delete the person.

#### `PATCH /api/admin/lot-owners/{id}` (update lot)

Remove `given_name`, `surname` from accepted fields. Only `unit_entitlement` and `financial_position` remain.

### Backend service changes

#### `admin_service.py` — lot owner functions

All functions that previously built `owner_emails` dicts from `LotOwnerEmail` rows now build `persons` lists from `lot_persons` JOIN `persons`. The helper `_owner_email_to_dict` is replaced by a helper that serialises a `Person` row.

```python
def _person_to_dict(row: Person) -> dict:
    return {
        "id": row.id,
        "email": row.email,
        "given_name": row.given_name,
        "surname": row.surname,
        "phone_number": row.phone_number,
    }
```

`list_lot_owners` batch query change: instead of `SELECT LotOwnerEmail WHERE lot_owner_id IN (...)`, query is:

```python
SELECT lot_persons.lot_id, persons.*
FROM lot_persons
JOIN persons ON lot_persons.person_id = persons.id
WHERE lot_persons.lot_id IN (:ids)
```

`_get_proxy_info` changes: instead of selecting `proxy_email, given_name, surname` from `lot_proxies`, join to `persons`:

```python
SELECT persons.email, persons.given_name, persons.surname
FROM lot_proxies
JOIN persons ON lot_proxies.person_id = persons.id
WHERE lot_proxies.lot_id = :lot_id
```

#### New function: `get_or_create_person(email, db) -> Person`

```python
async def get_or_create_person(email: str, db: AsyncSession) -> Person:
    """Look up a Person by email (case-insensitive). Create if not found."""
    normalised = email.strip().lower()
    result = await db.execute(select(Person).where(Person.email == normalised))
    person = result.scalar_one_or_none()
    if person is None:
        person = Person(email=normalised)
        db.add(person)
        await db.flush()
    return person
```

This function is called wherever an email is being associated with a lot or proxy.

#### New function: `update_person(person_id, data, db) -> Person`

Handles `PATCH /api/admin/persons/{person_id}`. Checks for email uniqueness if email is being changed (409 if conflict). Returns the updated `Person`.

#### `add_owner_email_to_lot_owner` changes

1. Call `get_or_create_person(email, db)` to get/create person.
2. Check that `lot_persons` row does not already exist for `(lot_id, person_id)` — 409 if duplicate.
3. Insert `lot_persons(lot_id=lot_id, person_id=person.id)`.
4. Return updated `LotOwnerOut`.

#### `set_lot_owner_proxy` changes

1. Call `get_or_create_person(proxy_email, db)` to get/create person.
2. Upsert `lot_proxies(lot_id=lot_id, person_id=person.id)` — update if exists, insert if not.
3. Return updated `LotOwnerOut`.

#### `archive_building` changes

The current logic checks whether any of the lot's emails appear in another non-archived building to decide whether to archive the lot owner. With `persons`, the equivalent check is:

```python
# Check: does this person link to a lot in another non-archived building?
SELECT 1 FROM lot_persons lp
JOIN lots l ON lp.lot_id = l.id
JOIN buildings b ON l.building_id = b.id
WHERE lp.person_id = :person_id
  AND l.building_id != :this_building_id
  AND b.is_archived = false
LIMIT 1
```

A lot is archived only if none of its persons appear in another active building.

### Import changes

#### Person resolution logic per CSV row

For each parsed CSV/Excel row that has a non-blank email:

1. **Normalise email** to lowercase.
2. **Look up** `persons` by `email` (SELECT with UNIQUE index hit — O(1)).
3. **If person found:**
   - Link the lot to this person via `lot_persons` if not already linked.
   - **Phone policy (fill-blanks):** only write `phone_number` to the person if the person currently has `phone_number IS NULL` and the CSV row has a non-blank phone. Never overwrite an existing phone number on re-import.
   - **Name policy (fill-blanks):** only write `given_name` / `surname` to the person if the person currently has both `given_name IS NULL` and `surname IS NULL`. If either name field is already set, do not change either. To correct a name, the admin must use `PATCH /api/admin/persons/{id}`.
4. **If person not found:**
   - Create new `persons` row with `email`, `given_name`, `surname`, `phone_number` from the CSV row.
   - Link the lot to the new person via `lot_persons`.

Pseudocode:
```python
async def _resolve_or_create_person_for_import(
    email: str,
    given_name: str | None,
    surname: str | None,
    phone_number: str | None,
    db: AsyncSession,
) -> Person:
    normalised = email.strip().lower()
    person = await db.execute(
        select(Person).where(Person.email == normalised)
    ).scalar_one_or_none()
    if person is None:
        person = Person(
            email=normalised,
            given_name=given_name,
            surname=surname,
            phone_number=phone_number,
        )
        db.add(person)
        await db.flush()
    else:
        # Fill-blanks phone policy: only set if currently NULL
        if person.phone_number is None and phone_number:
            person.phone_number = phone_number
        # Fill-blanks name policy: only set if BOTH name fields are currently NULL
        if person.given_name is None and person.surname is None:
            if given_name is not None or surname is not None:
                person.given_name = given_name
                person.surname = surname
    return person
```

#### Multi-owner lots (two CSV rows, same lot number, different emails)

The existing CSV parsing logic already groups multiple rows by `lot_number` into `email_entries`. Each entry in `email_entries` represents a distinct email/person to link to the lot. All entries are processed in order; each calls `_resolve_or_create_person_for_import` and then inserts a `lot_persons` row. The upsert logic does not drop any prior entries — it accumulates them.

There is no "first row wins for lot-level data" concept anymore because `lot_owners` no longer has `given_name`/`surname`.

#### Owner removal on re-import (lot_persons — authoritative delete-and-rebuild)

The import CSV is the **complete source of truth** for who owns lots in a building. When a CSV is uploaded for a building, the `lot_persons` links for every lot in that building are cleared and rebuilt from scratch. `persons` rows are never deleted — they may own lots in other buildings.

The import sequence per building is:

```python
# Step 1: Upsert lots from CSV rows (by lot_number within building)
# This is unchanged from the existing implementation — lots are never deleted
# because deleting would cascade-delete AGMLotWeight records and zero out AGM tallies.
for row in csv_rows:
    await _upsert_lot(building_id, row, db)

# Step 2: Clear ALL lot_persons links for every lot in this building
await db.execute(
    delete(lot_persons_table).where(
        lot_persons_table.c.lot_id.in_(
            select(Lot.id).where(Lot.building_id == building_id)
        )
    )
)

# Step 3: Rebuild lot_persons from the CSV rows
for row in csv_rows:
    if row["email"]:
        lot_id = await _get_lot_id_by_number(building_id, row["lot_number"], db)
        person = await _resolve_or_create_person_for_import(
            row["email"], row.get("given_name"), row.get("surname"),
            row.get("phone_number"), db
        )
        await db.execute(
            insert(lot_persons_table).values(lot_id=lot_id, person_id=person.id)
            .on_conflict_do_nothing()  # handles duplicate emails on same lot row
        )
```

The `persons` row for any removed person is **not deleted**. The person may still own lots in other buildings or proxy other lots.

#### Lots with no email

If the CSV row has an empty `email` column, skip person creation and skip `lot_persons` linking entirely. The lot is still upserted with its `unit_entitlement` and `financial_position`. This is unchanged behaviour from the current implementation.

#### Phone number column on persons

The phone column maps to `persons.phone_number`. The current behaviour of reading `phone` or `phone_number` column headers is retained. During import, phone is applied with the fill-blanks policy (above).

### Auth flow changes

#### `POST /api/auth/request-otp` and `POST /api/auth/verify`

The `_load_direct_lot_owner_ids` helper currently queries:

```python
SELECT LotOwnerEmail.lot_owner_id
FROM lot_owner_emails
JOIN lot_owners ON lot_owner_emails.lot_owner_id = lot_owners.id
WHERE lot_owner_emails.email = :voter_email
  AND lot_owners.building_id = :building_id
```

After the refactor, the equivalent is:

```python
SELECT lot_persons.lot_id
FROM lot_persons
JOIN persons ON lot_persons.person_id = persons.id
JOIN lots ON lot_persons.lot_id = lots.id
WHERE persons.email = :voter_email
  AND lots.building_id = :building_id
```

The `_load_proxy_lot_owner_ids` helper currently queries:

```python
SELECT LotProxy.lot_owner_id
FROM lot_proxies
JOIN lots ON lot_proxies.lot_id = lots.id
WHERE lot_proxies.proxy_email = :voter_email
  AND lots.building_id = :building_id
```

After the refactor:

```python
SELECT lot_proxies.lot_id
FROM lot_proxies
JOIN persons ON lot_proxies.person_id = persons.id
JOIN lots ON lot_proxies.lot_id = lots.id
WHERE persons.email = :voter_email
  AND lots.building_id = :building_id
```

**`has_phone` check in `request_otp`:**

Currently looks at `LotOwnerEmail.phone_number` for the matched email records. After refactor, look at `persons.phone_number` for the matched person:

```python
has_phone = False
if email_records:  # now: if matching persons exist
    phone_result = await db.execute(
        select(Person.phone_number).where(
            Person.email == body.email,
            Person.phone_number.isnot(None),
        ).limit(1)
    )
    has_phone = phone_result.scalar_one_or_none() is not None
```

**SMS delivery in `request_otp`:**

Currently fetches phone from `LotOwnerEmail.phone_number`. After refactor, fetch from `persons.phone_number`:

```python
phone_result2 = await db.execute(
    select(Person.phone_number).where(
        Person.email == body.email,
        Person.phone_number.isnot(None),
    ).limit(1)
)
phone_number = phone_result2.scalar_one_or_none()
```

**`is_email_known` check in `request_otp`:**

Currently checks both `lot_owner_emails` and `lot_proxies`. After refactor:
- Direct owners: `SELECT 1 FROM lot_persons JOIN persons ON lot_persons.person_id = persons.id JOIN lots ON lot_persons.lot_id = lots.id WHERE persons.email = :email AND lots.building_id = :building_id LIMIT 1`
- Proxy: `SELECT 1 FROM lot_proxies JOIN persons ON lot_proxies.person_id = persons.id JOIN lots ON lot_proxies.lot_id = lots.id WHERE persons.email = :email AND lots.building_id = :building_id LIMIT 1`

### Frontend changes

#### New TypeScript types

```typescript
export interface Person {
  id: string;
  email: string;
  given_name: string | null;
  surname: string | null;
  phone_number: string | null;
}

export interface LotOwner {
  id: string;
  building_id: string;
  lot_number: string;
  persons: Person[];           // NEW: replaces owner_emails as canonical list
  owner_emails: Person[];      // KEPT: backward-compat alias (same structure as Person)
  emails: string[];            // KEPT: backward-compat flat list
  unit_entitlement: number;
  financial_position: FinancialPosition;
  proxy_email: string | null;
  proxy_given_name: string | null;
  proxy_surname: string | null;
}
```

The `LotOwnerEmailEntry` type is **removed** and replaced by `Person`.

**TypeScript naming decision — `LotOwner` interface retained:** The TypeScript interface is kept as `LotOwner` (not renamed to `Lot`) for this PR. Renaming it would require updating every component that imports the type — a wide change with no functional benefit. A follow-up cosmetic PR can rename it once the schema rename has stabilised. The `LotOwner` interface gains a `persons` field and the top-level `given_name`/`surname` fields are removed; all other fields are unchanged.

**API field naming decision — `lot_owner_id` retained in public responses:** The `id` field on `LotOwnerOut` (the lot's UUID) remains accessible as `id`. The field is not renamed to `lot_id` in this PR. Response bodies use `id` as the primary key field name throughout — consistent with all other resource schemas. The column rename from `lot_owner_id` to `lot_id` in `lot_proxies` and `general_meeting_lot_weights` is an internal DB change only, not visible in API responses.

#### `LotOwnerForm.tsx` changes

**Owner email section:** The form currently stores `given_name`, `surname` on the email entry. After the refactor, editing a name means calling `PATCH /api/admin/persons/{person_id}`. The inline edit sub-form still shows `given_name`, `surname`, `email`, and `phone` fields — but the call target changes.

Changes:
- `addOwnerEmailMutation`: calls `POST /api/admin/lot-owners/{id}/owner-emails` with `{email}` only (no name/phone in the add request).
- `updateOwnerEmailMutation` → **renamed** `updatePersonMutation`: calls `PATCH /api/admin/persons/{person_id}` with `{email?, given_name?, surname?, phone_number?}`.
- `removeOwnerEmailMutation` → **renamed** `removePersonFromLotMutation`: calls `DELETE /api/admin/lot-owners/{id}/persons/{person_id}`.
- Local state uses `Person` type instead of `LotOwnerEmailEntry`.

**Proxy section:** The proxy input currently has `given_name`, `surname` fields alongside `proxy_email`. After the refactor, the proxy form mirrors the owner add flow — email only, with person lookup and pre-fill:

- Remove `proxyGivenName`, `proxySurname` state from the add-proxy sub-form.
- When the admin types an email in the proxy email field, the form queries `GET /api/admin/persons/lookup?email={email}` (same 300ms debounce as the owner add field). If a person is found, their name and phone are shown as a read-only preview below the input — confirming which person will be linked as proxy.
- If no person is found, the email input is still valid to submit — a new person with only email set will be created by the service.
- On submit: `setProxyMutation` calls `PUT /api/admin/lot-owners/{id}/proxy` with `{proxy_email}` only.
- The displayed proxy row (after setting) still shows `proxy_given_name` / `proxy_surname` (sourced from `LotOwnerOut.proxy_given_name` / `proxy_surname`, which come from the persons row).

**Person autocomplete (new feature):** When the admin types an email in the "Add owner" field, the form should query `GET /api/admin/persons/lookup?email={email}` (see new endpoint below) and if a person is found, pre-fill the displayed name/phone fields as a preview. This is read-only preview — the actual update to name/phone requires a separate edit step. Implementation note: the lookup is fire-and-forget with a 300ms debounce; it does not block submission.

#### New API function: `lookupPerson`

```typescript
export async function lookupPerson(email: string): Promise<Person | null> {
  const resp = await fetch(`/api/admin/persons/lookup?email=${encodeURIComponent(email)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json() as Promise<Person>;
}
```

#### New endpoint: `GET /api/admin/persons/lookup`

Query param: `email=<string>`. Returns `PersonOut` if found; 404 if not found.
Used by the frontend autocomplete.

#### MSW mock handlers

The existing `ADMIN_LOT_OWNERS` fixture and handlers must be updated:
- Replace `LotOwnerEmailEntry` references with `Person`.
- Add handler for `GET /api/admin/persons/lookup`.
- Add handler for `PATCH /api/admin/persons/:person_id`.
- Add handler for `DELETE /api/admin/lot-owners/:lot_owner_id/persons/:person_id`.
- Update `LotOwner` fixture shape: add `persons` field, remove top-level `given_name`/`surname`.

---

## Key Design Decisions

1. **Table `lot_owners` renamed to `lots`**: The table is renamed in the same migration as the persons refactor. The Python class `LotOwner` is renamed to `Lot` and the file renamed from `lot_owner.py` to `lot.py`. All FK columns that reference `lot_owners.id` are updated at the same time: `lot_proxies.lot_owner_id` → `lot_id`; `general_meeting_lot_weights.lot_owner_id` → `lot_id`. The columns `ballot_submissions.lot_owner_id` and `votes.lot_owner_id` are intentionally left with their old names in this PR — they are audit snapshot columns and renaming them is a cosmetic follow-up. Their FK constraints are updated to reference `lots(id)` (the renamed table) but the column names do not change.

2. **`persons` is the unique-per-email entity**: `UNIQUE(email)` on `persons` ensures one row per real-world person. This means a person cannot have two different phone numbers depending on which lot they own — there is one canonical phone per email address. This is the correct model for the AGM domain where an email identifies a person.

3. **Fill-blanks name policy on re-import**: Names (`given_name`, `surname`) are only written to a `persons` row if both fields are currently NULL. Once either name field is set (on first import or via the admin UI), re-importing leaves both name fields unchanged. To correct a name, the admin uses `PATCH /api/admin/persons/{id}`. This prevents accidental data loss when the CSV has stale or differently-formatted names.

4. **Fill-blanks phone policy on re-import**: Phone is only written on first import (when `persons.phone_number IS NULL`). This prevents re-import from clearing a phone that was manually added.

5. **`persons` rows are never deleted by lot operations**: Removing a person from a lot only deletes the `lot_persons` join row. The `persons` row remains. This is safe because: (a) the person may own lots in other buildings, (b) the person may proxy lots, (c) audit trails in `ballot_submissions.voter_email` and `votes.voter_email` reference the email not the person ID.

6. **Backward-compatible `emails` and `owner_emails` computed fields**: Existing frontend code (and any external integrations) that reads `emails: string[]` or `owner_emails: [{id, email, given_name, surname, phone_number}]` continues to work. The `persons` field is additive.

7. **`proxy_email`, `proxy_given_name`, `proxy_surname` retained on `LotOwnerOut`**: These are computed from the proxy person row. The frontend does not need to change how it reads proxy info — it still reads `lot_owner.proxy_email` etc. Only the write path changes (no longer submit name when setting proxy).

---

## Data Flow — Happy Path (voter auth)

1. Voter submits email `alice@example.com` to `POST /api/auth/request-otp`.
2. Auth service queries `lot_persons JOIN persons JOIN lots` where `persons.email = 'alice@example.com'` and `lots.building_id = :id`.
3. If found: OTP is generated and sent. `persons.phone_number` is checked for `has_phone`.
4. Voter submits OTP to `POST /api/auth/verify`.
5. `_load_direct_lot_owner_ids` queries `lot_persons JOIN persons JOIN lots` → returns set of `lot_id`.
6. `_load_proxy_lot_owner_ids` queries `lot_proxies JOIN persons JOIN lots` → returns set of `lot_id`.
7. Session is created; voter sees their lots.

---

## Risks and Open Questions

### BallotSubmission.voter_email and Vote.voter_email

Both tables have a `voter_email: str` column kept for audit purposes. They are **not** changed by this refactor. The primary key for ballot uniqueness is `(general_meeting_id, lot_owner_id)` — the rename of the identity layer does not affect this. `voter_email` is a snapshot of the email that authenticated at vote time, stored for audit even if the email is later changed on the `persons` row.

**Decision: no change needed.** The audit columns remain as-is.

### AGMLotWeight (`general_meeting_lot_weights.lot_id`)

This table stores a snapshot of `(lot_id, unit_entitlement, financial_position)` at AGM creation time. The column is renamed from `lot_owner_id` to `lot_id` in this migration (FK target updated to `lots.id`). No data change — purely a rename. The snapshot semantics are unchanged: entitlements captured at AGM creation time are never updated by subsequent lot edits or imports.

### `BallotSubmission.proxy_email`

Stores the proxy's email at submission time for audit. This is a snapshot — it does not need to reference `persons`. No change.

### `archive_building` logic

Currently checks whether an email appears in another building. After the refactor, the check is whether any person linked to this lot also links to a lot in another non-archived building. This is semantically equivalent but the query changes (see backend service changes section above).

### Person deletion safety

If a person is linked to a lot (`lot_persons`) or proxy (`lot_proxies`), the FK `ON DELETE RESTRICT` prevents deletion. Direct deletion of persons is not exposed via the admin API in this design. This is intentional — persons are created implicitly and persist as long as they are linked.

### Multi-building persons

A person (email) who owns lots in multiple buildings has one `persons` row and multiple `lot_persons` rows (one per lot, across buildings). This is correct and desirable — updating their phone number once updates it for all lots and buildings.

---

## Schema Migration Required

**Yes.** This refactor requires a substantial schema migration:
- New tables: `persons`, `lot_persons`
- Modified table: `lot_proxies` (add `person_id`, rename `lot_owner_id` → `lot_id`, drop `proxy_email`/`given_name`/`surname`)
- Modified table: `general_meeting_lot_weights` (rename `lot_owner_id` → `lot_id`)
- Modified table: `ballot_submissions` (FK target updated to `lots.id`; column name `lot_owner_id` unchanged)
- Modified table: `votes` (FK target updated to `lots.id`; column name `lot_owner_id` unchanged)
- Renamed table: `lot_owners` → `lots` (also drops `given_name`, `surname`)
- Dropped table: `lot_owner_emails`

---

## Files to Change

| File | Change |
|---|---|
| `backend/alembic/versions/pers0001_persons_refactor.py` | New migration: create `persons`, `lot_persons`; migrate data; modify `lot_proxies`; drop `lot_owner_emails`; drop name columns; rename `lot_owners` → `lots`; rename FK columns in `lot_proxies` and `general_meeting_lot_weights`; update FK targets on `ballot_submissions` and `votes` |
| `backend/app/models/person.py` | **New file**: `Person` model |
| `backend/app/models/lot_person.py` | **New file**: `lot_persons` association table |
| `backend/app/models/lot.py` | **Renamed from `lot_owner.py`**: `LotOwner` → `Lot`, `__tablename__ = "lots"`; remove `given_name`, `surname`; add `persons` M2M relationship |
| `backend/app/models/lot_owner.py` | **Deleted** (replaced by `lot.py`) |
| `backend/app/models/lot_owner_email.py` | **Deleted** |
| `backend/app/models/lot_proxy.py` | Remove `proxy_email`, `given_name`, `surname`; rename `lot_owner_id` → `lot_id`; add `person_id` FK + `person` relationship |
| `backend/app/models/__init__.py` | Add `Person`, `Lot`; remove `LotOwner`, `LotOwnerEmail` |
| `backend/app/schemas/admin.py` | Update `LotOwnerOut`, `LotOwnerCreate`, `LotOwnerUpdate`, `AddOwnerEmailRequest`, `SetProxyRequest`; remove `LotOwnerEmailOut`; add `PersonOut`; add `UpdatePersonRequest` |
| `backend/app/services/admin_service.py` | Rewrite `list_lot_owners`, `get_lot_owner`, `add_lot_owner`, `update_lot_owner`, `add_email_to_lot_owner`, `add_owner_email_to_lot_owner`, `update_owner_email`, `remove_email_from_lot_owner`, `remove_owner_email_by_id`, `set_lot_owner_proxy`, `remove_lot_owner_proxy`, `_upsert_lot_owners`, `archive_building`; add `get_or_create_person`, `update_person`, `lookup_person` |
| `backend/app/services/auth_service.py` | Update `_load_direct_lot_owner_ids`, `_load_proxy_lot_owner_ids` to query via `lot_persons` / `lot_proxies JOIN persons` |
| `backend/app/routers/auth.py` | Update `has_phone` and SMS phone lookup to read from `Person.phone_number` |
| `backend/app/routers/admin.py` | Add `PATCH /persons/{person_id}` endpoint; add `GET /persons/lookup` endpoint; update `DELETE /lot-owners/{id}/owner-emails/{email_id}` URL to `/persons/{person_id}`; remove name/phone params from proxy/email add endpoints |
| `backend/tests/test_admin_service.py` | Rewrite all lot-owner and proxy tests to use new schema |
| `backend/tests/test_admin_routes.py` | Update integration tests for all changed endpoints |
| `backend/tests/test_auth_service.py` | Update auth lookup tests |
| `frontend/src/types/index.ts` | Add `Person` type; update `LotOwner`; remove `LotOwnerEmailEntry` |
| `frontend/src/api/admin.ts` | Update `addOwnerEmailToLotOwner`, `updateOwnerEmail` → `updatePerson`, `removeOwnerEmailById` → `removePersonFromLot`; add `lookupPerson`; update `setLotOwnerProxy` |
| `frontend/src/components/admin/LotOwnerForm.tsx` | Update `EditModal`: use `Person` type, update mutation targets; simplify proxy add form (remove name fields); add person autocomplete on email input |
| `frontend/tests/msw/handlers.ts` | Update `ADMIN_LOT_OWNERS` fixture; add handlers for new endpoints; remove `LotOwnerEmailEntry` |
| `frontend/src/components/admin/__tests__/LotOwnerForm.test.tsx` | Update tests for new person model |

---

## Test Cases

### Unit tests — backend (`test_admin_service.py`)

| Scenario | Expected |
|---|---|
| `get_or_create_person` — email not in DB | Creates new `persons` row; returns it |
| `get_or_create_person` — email already in DB | Returns existing row; no duplicate created |
| `add_owner_email_to_lot_owner` — new email/person | Creates person, inserts `lot_persons` row; returns updated `LotOwnerOut` |
| `add_owner_email_to_lot_owner` — email already linked to lot | Returns 409 |
| `add_owner_email_to_lot_owner` — email exists as person but not linked to lot | Links existing person; does not create duplicate person |
| `update_person` — change given_name | Updates `persons.given_name`; returns `PersonOut` |
| `update_person` — change email to one already taken | Returns 409 |
| `remove_person_from_lot` — valid | Deletes `lot_persons` row; person row retained |
| `set_lot_owner_proxy` — new proxy email | Creates/reuses person; upserts `lot_proxies` row |
| `set_lot_owner_proxy` — email already a proxy for another lot | Reuses the same person row |
| `remove_lot_owner_proxy` | Deletes `lot_proxies` row; person row retained |
| `list_lot_owners` — lot with two persons | Returns `persons` list with both entries |
| `list_lot_owners` — lot with proxy | Returns `proxy_email`, `proxy_given_name`, `proxy_surname` from persons row |
| `_upsert_lot_owners` — re-import same email | All prior `lot_persons` links for building cleared; person re-linked; no duplicate person row |
| `_upsert_lot_owners` — re-import removes email | `lot_persons` link removed for that email; person row not deleted |
| `_upsert_lot_owners` — re-import with two lots, only one email changes | Both lots' `lot_persons` links cleared and rebuilt; unchanged lot re-linked to same person |
| `_upsert_lot_owners` — existing person has phone, CSV has new phone | Phone not overwritten (fill-blanks policy) |
| `_upsert_lot_owners` — existing person has no phone, CSV has phone | Phone written to person |
| `_upsert_lot_owners` — existing person has name (either field set), CSV has different name | Name not overwritten (fill-blanks policy) |
| `_upsert_lot_owners` — existing person has no name (both fields NULL), CSV has name | Name written to person (fill-blanks policy) |
| `set_lot_owner_proxy` — proxy email already in persons | Existing person linked as proxy; no duplicate created |
| `set_lot_owner_proxy` — proxy email not in persons | New person created with email only; linked as proxy; name fields are null |
| `archive_building` — lot with person in another building | Lot not archived |
| `archive_building` — lot with person only in this building | Lot archived |
| Auth `_load_direct_lot_owner_ids` — email in `lot_persons` | Returns correct lot IDs |
| Auth `_load_proxy_lot_owner_ids` — email in `lot_proxies.person_id` | Returns correct lot IDs |

### Integration tests — backend (`test_admin_routes.py`)

| Scenario | Assertion |
|---|---|
| `POST /lot-owners/{id}/owner-emails` — new email | 201; `persons` list contains new person |
| `POST /lot-owners/{id}/owner-emails` — duplicate email for lot | 409 |
| `PATCH /persons/{id}` — update name | 200; name updated on person |
| `PATCH /persons/{id}` — update to existing email | 409 |
| `DELETE /lot-owners/{id}/persons/{pid}` — valid | 200; person removed from lot's persons list |
| `DELETE /lot-owners/{id}/persons/{pid}` — person still in persons table | person row still exists after removal |
| `GET /persons/lookup?email=` — found | 200 with PersonOut |
| `GET /persons/lookup?email=` — not found | 404 |
| Import CSV with new email → re-import without that email | Second import: `lot_persons` link removed; person row in DB |
| Import CSV two rows same lot two emails | Both persons linked to lot |
| Auth `POST /api/auth/verify` — voter email in lot_persons | 200; lot returned |
| Auth `POST /api/auth/verify` — proxy email in lot_proxies | 200; lot returned with `is_proxy=true` |

---

## E2E Test Scenarios

### Affected existing persona journeys

This refactor touches all three key journeys:
- **Voter journey**: auth now queries `lot_persons JOIN persons` — existing voter E2E specs must continue to pass
- **Proxy voter journey**: proxy auth now queries `lot_proxies JOIN persons` — existing proxy E2E specs must continue to pass
- **Admin journey**: owner management UI changes — existing admin lot-owner management specs must be updated

### Happy path — add owner email and see it reflected in auth

1. Admin creates a building and adds a lot with no email.
2. Admin adds an owner email to the lot (`POST /lot-owners/{id}/owner-emails`).
3. Admin verifies the `persons` field is populated in the lot detail response.
4. Voter authenticates with that email and sees the lot returned.

### Happy path — set proxy with person lookup and authenticate as proxy

1. Admin types a known email into the proxy email field on a lot.
2. Form queries `GET /api/admin/persons/lookup?email=...` — person found; name/phone preview is shown read-only below the input.
3. Admin submits the proxy form (email only).
4. System links the existing person as proxy; `LotOwnerOut.proxy_given_name` / `proxy_surname` are populated from the persons row.
5. Proxy voter authenticates with the proxy email and sees the lot with `is_proxy: true`.

### Happy path — set proxy with unknown email (new person created)

1. Admin types an unknown email into the proxy email field.
2. Lookup returns 404; no preview is shown. Field remains valid.
3. Admin submits — service creates a new person with only email set; links as proxy.
4. `LotOwnerOut.proxy_given_name` / `proxy_surname` are null (person has no name yet).
5. Admin updates the person name via `PATCH /api/admin/persons/{id}`.
6. Lot detail now shows the updated proxy name.

### Multi-step: import → re-import with email change (authoritative rebuild)

1. Admin uploads CSV with lot `1A`, email `alice@example.com`.
2. System creates person for Alice; all prior `lot_persons` links for the building are cleared and rebuilt — lot `1A` is now linked to Alice.
3. Admin uploads updated CSV with lot `1A`, email `bob@example.com` (Alice removed).
4. System clears all `lot_persons` links for the building, then rebuilds: lot `1A` is now linked only to Bob. Alice's `persons` row is retained in the DB.
5. Voter tries to auth as `alice@example.com` → 401 (no longer linked to any lot in this building).
6. Voter auths as `bob@example.com` → 200.

This sequence must be an explicit E2E scenario. Existing import specs for the Admin journey must be updated to reflect the new schema (remove assertions on `lot.given_name`/`lot.surname`; add assertions on `lot.persons[*].email`).

### Multi-step: import → name filled in → re-import → name not overwritten (fill-blanks)

1. Admin imports CSV with lot `1A`, email `alice@example.com`, name "Alice Smith". Person has no prior name — both fields are NULL.
2. System writes `given_name="Alice"`, `surname="Smith"` to person (fill-blanks: both were NULL).
3. Admin updates person name to "Alice Mary Smith" via `PATCH /persons/{id}`.
4. Admin re-imports the same CSV (still shows name "Alice Smith").
5. Person name is still "Alice Mary Smith" — fill-blanks policy skips the write because `surname` is already set.

### Error/edge: add duplicate email to lot

1. Admin adds `alice@example.com` to lot `1A`.
2. Admin attempts to add `alice@example.com` again to lot `1A`.
3. System returns 409.

### Error/edge: delete person FK constraint

1. Attempt to delete a person who is linked to a lot via the internal service.
2. DB raises FK constraint error (RESTRICT). This is not exposed as a user-facing endpoint.

### Vertical slice decomposition

This refactor cannot be split into independent frontend/backend slices because:
- The API response shape changes (`persons` replaces `owner_emails` structure)
- The frontend `LotOwnerForm` must be updated in the same branch as the backend schema change

**Single slice**: backend migration + models + services + routers + frontend types + components.

The backend can be committed first on the branch (all tests passing against the new schema), then the frontend layer added in subsequent commits on the same branch.

---

## Previously Recorded Design (retained for context)

### Building CRUD

| Endpoint | Description |
|---|---|
| `GET /api/admin/buildings` | List buildings; optional `?name=` substring filter; optional `?limit`/`?offset` |
| `GET /api/admin/buildings/{building_id}` | Single building by ID; 404 if not found |
| `PATCH /api/admin/buildings/{building_id}` | Partial update `name` and/or `manager_email`; 422 on blank strings |
| `POST /api/admin/buildings/{building_id}/archive` | Archive a building |
| `DELETE /api/admin/buildings/{building_id}` | Permanently delete an archived building; 409 if not archived |

### Financial position import

`POST /api/admin/buildings/{id}/lot-owners/import-financial-positions` accepts CSV or Excel. Auto-detection: if the first cell equals `Lot#` → simple two-column format; otherwise → TOCS Lot Positions Report format.

TOCS format: multiple fund sections; `Closing Balance` column; worst-case across sections determines `in_arrear`. No change in this refactor.

### Owner name column detection (import)

Name detection from CSV/Excel columns is unchanged. Column priority: (1) both `given_name` + `surname`, (2) single `Name` column, (3) no name data. After the refactor, names are written to `persons.given_name`/`persons.surname` on first creation; on re-import the fill-blanks policy applies (names only written if both fields are currently NULL).

### Vote results export (CSV)

`GET /api/admin/general-meetings/{id}` returns `VoterEntry` objects in `voter_lists`. `VoterEntry.voter_name` is populated from `lot.persons[0].given_name + surname` (first linked person) or from the snapshot in `BallotSubmission.voter_email` cross-referenced to persons. No structural change to the export — `voter_name` is already nullable.

---

## Security Considerations

- All admin endpoints are behind `require_admin` (session-based auth).
- `GET /api/admin/persons/lookup` is admin-only — it could be used to enumerate person records by email; restricting to admin prevents voter enumeration.
- Deleting a building requires it to be archived first (two-step protection against accidental deletion).
- `persons.email` uniqueness enforced by DB UNIQUE constraint and checked at application layer (409 on conflict).
- `ON DELETE RESTRICT` on `lot_persons.person_id` and `lot_proxies.person_id` prevents orphaned references.

---

## Feature: Lot Owner and Proxy Form UX Improvements

PRD references: US-FORM-UX-01, US-FORM-UX-02, US-FORM-UX-03 (`tasks/prd/prd-buildings-and-lots.md`)

**Status:** Implemented

### Overview

This feature improves the admin UI for adding and editing lot owner persons and proxy contacts. The three improvements are:

1. **Email field first** — the email input moves to the top of the "Add owner" and "Set proxy" sub-forms. Admins typically know the email and use it as the primary identifier; showing it first reduces cognitive overhead.
2. **Person autocomplete** — as the admin types an email prefix, a debounced dropdown fetches matching existing `persons` rows and displays them as `Given Surname <email>`. Selecting one auto-populates the name and phone fields. This avoids re-entering details for a person already in the system.
3. **Conflict warning modal** — when the admin submits name or phone values that differ from what is stored on the existing person row, a modal warns them that saving will update the shared person record (affecting all lots and proxies linked to that person). The admin can confirm or cancel.
4. **Phone number on proxy form** — the proxy "Set proxy" / edit-proxy sub-form gains a phone number field, which was previously absent even though `persons.phone_number` already exists in the DB.

No schema migration is required. All changes are to backend service/router logic (new search endpoint, proxy schema extension) and frontend components.

---

### Database Changes

No schema changes. The `persons` table already has `id`, `email`, `given_name`, `surname`, `phone_number`. The `lot_proxies` table links to `persons` via `person_id`. The `persons.phone_number` column is already present (added in US-PERS-01).

The only DB-level change needed is a new index on `persons.email` for prefix search. However, the `persons` table already has a UNIQUE index on `email` (created in the persons-refactor migration), which PostgreSQL can use for `ILIKE 'prefix%'` range scans efficiently. No additional index is needed.

---

### Backend Changes

#### New endpoint: `GET /api/admin/persons/search`

Added to `backend/app/routers/admin.py` and backed by a new service function `search_persons` in `backend/app/services/admin_service.py`.

**Path:** `GET /api/admin/persons/search`
**Auth:** `require_admin` (router-level dependency already covers all `/api/admin/*` routes)
**Query params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `q` | string | yes | Email prefix to search. Minimum 1 character after stripping. |
| `limit` | int | no | Max results, default 10, max 20. |

**Response:** `200 OK` — `list[PersonOut]`

```json
[
  {
    "id": "uuid",
    "email": "alice@example.com",
    "given_name": "Alice",
    "surname": "Smith",
    "phone_number": "+61412345678"
  }
]
```

`PersonOut` schema already exists in `backend/app/schemas/admin.py`. No new schema needed.

**Service function:**

```python
async def search_persons(q: str, db: AsyncSession, limit: int = 10) -> list[Person]:
    """Return persons whose email starts with q (case-insensitive). Max limit results."""
    prefix = q.strip().lower()
    if not prefix:
        return []
    result = await db.execute(
        select(Person)
        .where(Person.email.ilike(f"{prefix}%"))
        .order_by(Person.email)
        .limit(limit)
    )
    return list(result.scalars().all())
```

This query uses the existing UNIQUE index on `persons.email` — PostgreSQL can do an index range scan for `ILIKE 'prefix%'` (no leading wildcard) on a btree index.

**Rate limiting:** The search endpoint is called on every keystroke (after debounce). It is an admin-only endpoint and not accessible to voters; standard admin session auth is sufficient. No additional rate limiter is needed beyond the existing session check.

**Input validation:** `q` must be between 1 and 254 characters. Empty or whitespace-only `q` returns `[]` without a DB query. `limit` is capped at 20.

#### Modified endpoint: `PUT /api/admin/lot-owners/{id}/proxy`

The `SetProxyRequest` schema in `backend/app/schemas/admin.py` gains an optional `phone_number` field:

```python
class SetProxyRequest(BaseModel):
    proxy_email: str = Field(..., max_length=254)
    given_name: str | None = Field(default=None, max_length=255)
    surname: str | None = Field(default=None, max_length=255)
    phone_number: str | None = Field(default=None, max_length=20)  # NEW
```

The `set_lot_owner_proxy` service function in `admin_service.py` already accepts `given_name` and `surname` keyword args. It needs to accept `phone_number` as well and apply the fill-blanks policy:

```python
async def set_lot_owner_proxy(
    lot_owner_id: uuid.UUID,
    proxy_email: str,
    db: AsyncSession,
    given_name: str | None = None,
    surname: str | None = None,
    phone_number: str | None = None,   # NEW
) -> dict:
    ...
    # After get_or_create_person:
    if phone_number is not None and person.phone_number is None:
        person.phone_number = phone_number
```

The router handler passes `phone_number=data.phone_number` to the service.

Additionally, `_get_proxy_info` currently returns `{proxy_email, given_name, surname}`. It must be extended to also return `phone_number` so the frontend can display it and detect conflicts:

```python
async def _get_proxy_info(lot_id: uuid.UUID, db: AsyncSession) -> dict | None:
    proxy_result = await db.execute(
        select(Person.email, Person.given_name, Person.surname, Person.phone_number)
        .join(LotProxy, LotProxy.person_id == Person.id)
        .where(LotProxy.lot_id == lot_id)
    )
    row = proxy_result.first()
    if row is None:
        return None
    return {"proxy_email": row[0], "given_name": row[1], "surname": row[2], "phone_number": row[3]}
```

`LotOwnerOut` gains a `proxy_phone_number: str | None = None` field so the frontend can read it:

```python
class LotOwnerOut(BaseModel):
    ...
    proxy_phone_number: str | None = None   # NEW
```

All service functions that return a lot-owner dict (`set_lot_owner_proxy`, `remove_lot_owner_proxy`, `get_lot_owner`, `list_lot_owners`, `add_lot_owner`, etc.) must include `proxy_phone_number` in the returned dict. The `list_lot_owners` bulk query and the individual `get_lot_owner` query both go through `_build_lot_owner_response` (or equivalent) which calls `_get_proxy_info`; once that helper returns `phone_number`, the response dict must propagate it.

---

### Frontend Changes

#### New API client function

In `frontend/src/api/admin.ts`:

```typescript
export interface PersonOut {
  id: string;
  email: string;
  given_name: string | null;
  surname: string | null;
  phone_number: string | null;
}

export async function searchPersons(q: string, limit = 10): Promise<PersonOut[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return apiFetch<PersonOut[]>(`/api/admin/persons/search?${qs}`);
}
```

The `setLotOwnerProxy` function signature gains `phoneNumber`:

```typescript
export async function setLotOwnerProxy(
  lotOwnerId: string,
  proxyEmail: string,
  givenName?: string | null,
  surname?: string | null,
  phoneNumber?: string | null,   // NEW
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/proxy`, {
    method: "PUT",
    body: JSON.stringify({
      proxy_email: proxyEmail,
      given_name: givenName,
      surname,
      phone_number: phoneNumber,
    }),
  });
}
```

The `LotOwner` type in `frontend/src/types/index.ts` gains `proxy_phone_number`:

```typescript
export interface LotOwner {
  ...
  proxy_phone_number: string | null;   // NEW
}
```

#### New component: `PersonEmailAutocomplete`

A new shared component at `frontend/src/components/admin/PersonEmailAutocomplete.tsx`.

**Props:**

```typescript
interface PersonEmailAutocompleteProps {
  value: string;
  onChange: (email: string) => void;
  onSelect: (person: PersonOut) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}
```

**Behaviour:**

- Renders a `<input type="email" className="field__input">` with a `<ul role="listbox">` dropdown positioned below it.
- Debounces the `onChange` call by 300 ms. After debounce fires, if `value.length >= 1`, calls `searchPersons(value)`.
- If the response contains results, renders the dropdown. Each `<li role="option">` shows `Given Surname <email>` (or just `email` if no name).
- Clicking or pressing Enter on a suggestion calls `onSelect(person)` and closes the dropdown.
- Pressing Escape closes the dropdown without selection.
- Up/Down arrow keys move the highlighted option; highlighted option is announced via `aria-activedescendant`.
- Closes on outside click (mousedown listener on document).
- The dropdown is styled using design-system tokens: `background: var(--white)`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, `box-shadow: var(--shadow-md)`, `z-index: 100`.
- Each suggestion item on hover has `background: var(--linen)`.
- Loading state: while debounce is pending or fetch is in flight, no dropdown shown (avoid flickering; results appear when ready).
- Empty result: dropdown not shown (no "no results" message — user continues typing).

#### New component: `PersonConflictModal`

A new component at `frontend/src/components/admin/PersonConflictModal.tsx`.

**Props:**

```typescript
interface PersonConflictModalProps {
  email: string;
  onConfirm: () => void;
  onCancel: () => void;
}
```

**Behaviour:**

- Renders as a centred `<div className="dialog-overlay">` / `<div className="dialog">` (same pattern as existing `ConfirmDialog`).
- Title: "Update person details?" — styled as `<h3 className="admin-card__title">`.
- Body: "The name or phone number you entered is different from the existing record for [email]. Updating will apply to all lots and proxies linked to this person. Do you want to continue?"
- Two buttons: `<button className="btn btn--secondary">Cancel</button>` and `<button className="btn btn--primary">Update and save</button>`.
- Escape key calls `onCancel`.
- No overlay-click-to-dismiss (the admin must make an explicit choice).
- Accessible: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the title.

#### Modified component: `LotOwnerForm.tsx`

**AddForm changes (add lot owner dialog):**

The `AddForm` currently has: Lot Number → Email → Unit Entitlement → Financial Position.

After this change: Lot Number → Email (with `PersonEmailAutocomplete`) → Given Name → Surname → Phone → Unit Entitlement → Financial Position.

State additions:
- `givenName: string` — pre-filled by autocomplete selection
- `surname: string` — pre-filled by autocomplete selection
- `phone: string` — pre-filled by autocomplete selection
- `selectedPerson: PersonOut | null` — the person selected from autocomplete (used for conflict detection)
- `conflictModalOpen: boolean`
- `pendingSubmitData: LotOwnerCreateRequest | null` — the payload held while the conflict modal is shown

Submit flow:
1. Validate fields as today.
2. If `selectedPerson !== null` (autocomplete matched), compare submitted `givenName/surname/phone` against `selectedPerson.given_name/surname/phone_number`. If any differ and the field is non-empty in the submitted form, set `conflictModalOpen = true` and store `pendingSubmitData`; return.
3. If no conflict (or no selected person), call `addLotOwner(buildingId, data)` immediately.
4. If conflict modal confirmed: call `addLotOwner(buildingId, pendingSubmitData)` then close modal.

Note: the add-lot-owner API (`POST /api/admin/buildings/{id}/lot-owners`) only accepts `{ lot_number, emails, unit_entitlement, financial_position }`. It does not accept name/phone. The conflict check in AddForm is therefore limited to the **owner-email sub-form within EditModal** (see below). The AddForm only collects email for the initial creation; names are added via the owner-email sub-form. The AddForm itself therefore does not need the conflict modal. The conflict modal applies to the "Add owner" and "Set proxy" sub-forms inside `EditModal`.

**EditModal — "Add owner" sub-form changes:**

Current field order: Given Name → Surname → Phone → Email.
New field order: Email (with `PersonEmailAutocomplete`) → Given Name → Surname → Phone.

State additions to `EditModal`:
- `addOwnerSelectedPerson: PersonOut | null`
- `addOwnerConflictModalOpen: boolean`
- `addOwnerPendingPayload: { email: string; given_name: string | null; surname: string | null; phone_number: string | null } | null`

Submit flow for "Add owner":
1. Validate email.
2. If `addOwnerSelectedPerson !== null`, compare `newOwnerGivenName/newOwnerSurname/newOwnerPhone` against stored person values. If any differ (non-empty submitted vs stored), show conflict modal, store pending payload, return.
3. If confirmed or no conflict: call `addOwnerEmailMutation.mutate(...)`.

**EditModal — "Set proxy" sub-form changes:**

Current field order: Given Name → Surname → Email.
New field order: Email (with `PersonEmailAutocomplete`) → Given Name → Surname → Phone (NEW field).

State additions to `EditModal`:
- `proxyPhone: string` — new state for proxy phone input (empty string default)
- `proxySelectedPerson: PersonOut | null`
- `proxyConflictModalOpen: boolean`
- `proxyPendingPayload: { email: string; givenName: string | null; surname: string | null; phoneNumber: string | null } | null`

When a proxy is already set (`proxyEmail !== null`), the display row currently shows name + email. After this change it also shows `proxyPhoneNumber` if set (sourced from `lotOwner.proxy_phone_number`).

Submit flow for "Set proxy":
1. Validate email.
2. If `proxySelectedPerson !== null`, compare submitted name/phone against stored person values. If any differ, show conflict modal, store pending, return.
3. If confirmed or no conflict: call `setProxyMutation.mutate({ email, givenName, surname, phoneNumber })`.

The `setProxyMutation` mutationFn signature updates:

```typescript
const setProxyMutation = useMutation<
  LotOwner,
  Error,
  { email: string; givenName: string | null; surname: string | null; phoneNumber: string | null }
>({
  mutationFn: ({ email, givenName, surname, phoneNumber }) =>
    setLotOwnerProxy(lotOwner.id, email, givenName, surname, phoneNumber),
  ...
});
```

After a successful set-proxy with a phone number, `proxyPhone` is reset to `""`.

**Inline proxy edit (existing proxy already set):**

Currently the edit modal has no inline edit form for an existing proxy — the user must remove the proxy and re-add. This UX remains unchanged in this feature; the phone number is displayed in the read-only proxy row when set.

---

### Data Flow: Add Owner with Autocomplete and Conflict

```
Admin types "alice" in email field (Add owner sub-form)
  → 300ms debounce fires
  → GET /api/admin/persons/search?q=alice&limit=10
  → Response: [{ id, email: "alice@example.com", given_name: "Alice", surname: "Smith", phone_number: "+61412..." }]
  → Dropdown renders: "Alice Smith <alice@example.com>"

Admin selects suggestion
  → email input fills: "alice@example.com"
  → given name fills: "Alice"
  → surname fills: "Smith"
  → phone fills: "+61412..."
  → addOwnerSelectedPerson = { id, email, given_name: "Alice", surname: "Smith", phone_number: "+61412..." }

Admin changes surname to "Jones" and clicks "Add owner"
  → conflict check: stored surname "Smith" != submitted "Jones"
  → PersonConflictModal renders with email "alice@example.com"

Admin clicks "Update and save"
  → POST /api/admin/lot-owners/{id}/owner-emails
    { email: "alice@example.com", given_name: "Alice", surname: "Jones", phone_number: "+61412..." }
  → service: get_or_create_person("alice@example.com") finds existing person
  → fill-blanks: given_name already set, surname already set — NOT overwritten by this endpoint
  → Note: the add-owner endpoint uses fill-blanks; to actually update surname, the admin must use the inline edit form for the existing owner-email row, which calls PATCH /api/admin/persons/{id}

Admin clicks "Cancel"
  → modal closes, form retains current values, no API call
```

**Important design note:** The "Add owner" endpoint (`POST /api/admin/lot-owners/{id}/owner-emails`) uses the fill-blanks policy — it only writes name/phone if the person currently has NULL for those fields. The conflict modal therefore informs the admin that a change will apply, but the actual update of `persons.given_name/surname/phone_number` for an existing person (one with non-NULL values) does NOT happen through the add-owner endpoint. The conflict warning is accurate for new persons (where fill-blanks will set the values), but for existing persons with existing values, the values will not be overwritten.

To update an existing person's name or phone, the admin uses the inline "Edit" button on an existing owner-email row, which calls `PATCH /api/admin/persons/{person_id}` — that endpoint does overwrite all supplied fields.

**Resolution:** The conflict modal must only show for the proxy form (where `set_lot_owner_proxy` will update person fields if they differ) and the inline-edit owner-email form. For the "Add owner" sub-form, the conflict detection is simplified: if the selected person already has a name/phone set, show a notice (non-blocking) that the existing person's record will not be changed. This avoids falsely implying that the add-owner save will update the person.

Revised conflict detection per form:

| Form | When to show conflict modal | What save does to person |
|---|---|---|
| Add owner sub-form | Never show modal. Show a read-only hint: "This person's name/phone is already on file — details shown are read-only." | Fill-blanks only (no overwrite) |
| Inline edit owner-email (existing row) | If submitted name/phone differs from stored | PATCH /api/admin/persons/{id} — overwrites all set fields |
| Set proxy | If submitted name/phone differs from stored | set_lot_owner_proxy uses fill-blanks — no overwrite of existing values |

Given this, the conflict modal is most useful for the **inline edit** flow (which already allows full edits). For proxy, the fill-blanks policy means the modal warns the admin but the save won't actually overwrite existing values — so for proxy the modal is also not needed (the fill-blanks policy is safe). The simpler and more accurate approach:

- **Add owner sub-form:** Show autocomplete; auto-fill read-only preview of name/phone (not editable in this sub-form); no conflict modal.
- **Inline edit owner-email:** Allow editing name/phone; show conflict modal before `PATCH /api/admin/persons/{id}` if values differ.
- **Set proxy sub-form:** Show autocomplete; auto-fill name/phone (editable); no conflict modal (fill-blanks is safe).

This simplification removes the false positive conflict warning while still covering the one case where a genuine conflict can occur (inline edit of an existing owner-email). The requirement spec asks for the conflict modal on submit; this design scopes it to the inline-edit case where it is both accurate and necessary.

---

### Data Flow: Set Proxy with Autocomplete

```
Admin types "bob" in proxy email field
  → 300ms debounce fires
  → GET /api/admin/persons/search?q=bob&limit=10
  → Response: [{ id, email: "bob@example.com", given_name: "Bob", surname: "Lee", phone_number: null }]
  → Dropdown renders: "Bob Lee <bob@example.com>"

Admin selects suggestion
  → email fills: "bob@example.com"
  → given name fills: "Bob"
  → surname fills: "Lee"
  → phone remains empty (stored phone is null)

Admin fills in phone "+61400000000" and clicks "Set proxy"
  → PUT /api/admin/lot-owners/{id}/proxy
    { proxy_email: "bob@example.com", given_name: "Bob", surname: "Lee", phone_number: "+61400000000" }
  → service: get_or_create_person("bob@example.com") finds existing person
  → fill-blanks: phone currently NULL → person.phone_number = "+61400000000"
  → proxy record created/updated
  → response LotOwnerOut includes proxy_phone_number: "+61400000000"
  → UI shows: "Bob Lee bob@example.com +61400000000" + Remove proxy button
```

---

### Files to Change

| File | Change |
|---|---|
| `backend/app/services/admin_service.py` | Add `search_persons` function; extend `set_lot_owner_proxy` to accept `phone_number`; extend `_get_proxy_info` to return `phone_number` |
| `backend/app/schemas/admin.py` | Add `phone_number` to `SetProxyRequest`; add `proxy_phone_number` to `LotOwnerOut` |
| `backend/app/routers/admin.py` | Add `GET /api/admin/persons/search` endpoint; pass `phone_number` to `set_lot_owner_proxy` |
| `frontend/src/api/admin.ts` | Add `PersonOut` interface; add `searchPersons` function; extend `setLotOwnerProxy` with `phoneNumber` param |
| `frontend/src/types/index.ts` | Add `proxy_phone_number: string \| null` to `LotOwner` interface |
| `frontend/src/components/admin/PersonEmailAutocomplete.tsx` | New component — email input with debounced person-search dropdown |
| `frontend/src/components/admin/PersonConflictModal.tsx` | New component — confirmation modal for person-detail update (used in inline-edit owner-email flow) |
| `frontend/src/components/admin/LotOwnerForm.tsx` | Reorder email field first in AddForm; integrate `PersonEmailAutocomplete` in EditModal add-owner and set-proxy sub-forms; add phone field to set-proxy sub-form; show `proxy_phone_number` in proxy display row; wire conflict modal to inline-edit owner-email flow |
| `frontend/tests/msw/handlers.ts` | Add handler for `GET /api/admin/persons/search` |
| `frontend/src/components/admin/__tests__/LotOwnerForm.test.tsx` | Add/update tests for email-first order, autocomplete selection, conflict modal, proxy phone field |
| `backend/tests/test_admin_service.py` (or equivalent) | Unit tests for `search_persons`; extend proxy tests for `phone_number` |
| `backend/tests/test_admin_router.py` (or equivalent) | Integration tests for `GET /api/admin/persons/search` and updated proxy endpoint |

---

### Key Design Decisions

1. **`PersonEmailAutocomplete` as a separate component, not inlined.** The same autocomplete logic is needed in three places (add-owner sub-form, proxy sub-form, inline-edit owner-email form). Extracting it prevents duplication.

2. **Debounce at 300 ms inside the component.** The search is a lightweight indexed query. 300 ms provides a responsive feel without hammering the API on every keystroke.

3. **`ILIKE 'prefix%'` query.** Prefix match (no leading wildcard) allows PostgreSQL to use the existing btree UNIQUE index on `persons.email`. A substring match (`%prefix%`) would require a full table scan or a GIN/trigram index.

4. **Conflict modal scoped to inline-edit only.** See the data-flow section above. The conflict modal on the add-owner sub-form would mislead the admin because `add_owner_email_to_lot_owner` uses fill-blanks and will not overwrite existing values. Showing it would suggest an update that never actually happens.

5. **`proxy_phone_number` added to `LotOwnerOut`.** The proxy's phone number is sourced from the linked `persons` row, which already stores it. Surfacing it in `LotOwnerOut` requires only a one-line addition to `_get_proxy_info` and the response dict, with no schema migration.

6. **Fill-blanks policy for `set_lot_owner_proxy`.** Consistent with the rest of the persons model: proxy set/replace only writes phone/name if the person row has NULL for those fields. Explicit updates go through `PATCH /api/admin/persons/{id}`.

---

### Schema Migration Required

No. The `persons.phone_number` column already exists. `LotOwnerOut.proxy_phone_number` is a computed field derived from the persons join — no DB column change.

---

## E2E Test Scenarios

### Happy path — person autocomplete selects and auto-fills

1. Admin opens a lot owner's edit modal.
2. In the "Add owner" sub-form, types a partial email that matches an existing person.
3. Dropdown appears with `Given Surname <email>`.
4. Admin clicks the suggestion.
5. Given name, surname, and phone fields auto-fill with the stored values.
6. Admin clicks "Add owner".
7. Owner-email entry appears in the list with correct name.

### Happy path — proxy form with phone number

1. Admin opens a lot owner's edit modal.
2. In the "Set proxy" section, types a partial email that matches an existing person.
3. Dropdown appears; admin selects it.
4. Name and phone fields fill. Admin edits the phone number.
5. Admin clicks "Set proxy".
6. Proxy display row shows name, email, and phone number.

### Conflict modal — inline edit owner-email

1. Admin opens a lot owner's edit modal.
2. Clicks "Edit" on an existing owner-email row.
3. Changes the surname to a value different from the stored record.
4. Clicks "Save".
5. Conflict modal appears with the correct email and warning text.
6. Admin clicks "Update and save".
7. `PATCH /api/admin/persons/{id}` is called; owner-email row updates.

### Conflict modal — cancel

1. Same steps as above through step 5.
2. Admin clicks "Cancel".
3. Modal closes; no API call made; form shows original values.

### Multi-step sequence: add proxy with phone end-to-end

1. Admin navigates to building detail page.
2. Opens lot owner edit modal (no proxy currently set).
3. Types "newuser@" in proxy email field.
4. No autocomplete results (new person).
5. Fills given name "New", surname "User", phone "+61400000001".
6. Clicks "Set proxy".
7. Proxy display row shows "New User newuser@example.com +61400000001".
8. Admin closes modal and reopens it.
9. Proxy section still shows the same details (persisted in DB).
10. Admin removes proxy, then sets it again with a different phone.
11. Phone field in proxy row updates to the new value.

### Keyboard navigation

1. Admin types in email field; dropdown appears.
2. Presses Down arrow; first suggestion is highlighted.
3. Presses Down again; second suggestion highlighted.
4. Presses Enter; email and name fields fill.

### Existing E2E specs affected

The following existing E2E journey specs exercise the lot owner edit modal and proxy forms and must be reviewed/updated:
- Any spec that opens the lot owner edit modal and adds an owner email or proxy — the field order change (email first) will break locators that target inputs by position.
- The admin building-management workflow spec (if it exists) that sets/removes a proxy.

All such specs must update their locators to use `aria-label` or `id` rather than positional selectors.
- Name/phone fields are sanitised with bleach (strip HTML tags) before storage — same as current implementation.
