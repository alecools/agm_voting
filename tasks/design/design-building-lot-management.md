# Design: Building and Lot Management

## Overview

Admins manage buildings (create, edit, archive, delete) and their associated lot owners (add, edit, delete, import from CSV/Excel, assign proxy nominations, import financial positions). Lot owners have optional names, optional emails, and a financial position (`normal` or `in_arrear`). Emails are stored in a separate `lot_owner_emails` table supporting zero or more addresses per lot. A vote results export adds a "Voter Email" column to the CSV. Financial positions can be imported individually or from a TOCS Lot Positions Report.

---

## Root Cause / Background

Buildings are the top-level organisational unit. Each building has many lot owners, each of which may vote in an AGM. Multi-email support accommodates co-owners. Optional emails allow estate-managed lots with no known email. Financial position tracking determines vote eligibility on General Motions.

---

## Technical Design

### Database changes

**`buildings` table** (existing):

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR | NOT NULL, UNIQUE |
| `manager_email` | VARCHAR | NOT NULL |
| `is_archived` | BOOLEAN | NOT NULL, default `false` |
| `created_at` | TIMESTAMPTZ | |

**`lot_owners` table** (existing + additions):

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `building_id` | UUID FK → `buildings.id` CASCADE | |
| `lot_number` | VARCHAR | NOT NULL |
| `unit_entitlement` | INTEGER | NOT NULL |
| `financial_position` | Enum(`normal`, `in_arrear`) | NOT NULL, default `normal` |
| `given_name` | VARCHAR | nullable |
| `surname` | VARCHAR | nullable |

**`lot_owner_emails` table** — zero-or-more emails per lot owner:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `lot_owner_id` | UUID FK → `lot_owners.id` CASCADE | NOT NULL |
| `email` | VARCHAR | nullable per row; rows simply absent when no email |

Index: `ix_lot_owner_emails_email` on `email`. Unique constraint on `(lot_owner_id, email)` named `uq_lot_owner_emails_owner_email`.

**`lot_proxies` table** — proxy nominations:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `lot_owner_id` | UUID FK → `lot_owners.id` CASCADE | NOT NULL |
| `proxy_email` | VARCHAR | NOT NULL |
| `given_name` | VARCHAR | nullable |
| `surname` | VARCHAR | nullable |
| `created_at` | TIMESTAMPTZ | |

Unique constraint on `lot_owner_id` (one active proxy per lot). Index on `proxy_email`.

**`ballot_submissions`** — `is_absent: bool` column added to distinguish actual voter submissions from absent-lot records created at meeting close.

### Backend changes

#### Building CRUD

| Endpoint | Description |
|---|---|
| `GET /api/admin/buildings` | List buildings; optional `?name=` substring filter (case-insensitive `LIKE`); optional `?limit`/`?offset` |
| `GET /api/admin/buildings/{building_id}` | Single building by ID; 404 if not found |
| `PATCH /api/admin/buildings/{building_id}` | Partial update `name` and/or `manager_email`; 422 on blank strings |
| `POST /api/admin/buildings/{building_id}/archive` | Archive a building |
| `DELETE /api/admin/buildings/{building_id}` | Permanently delete an **archived** building; 409 if not archived; cascades all child data |

#### Lot owner CRUD and import

| Endpoint | Description |
|---|---|
| `GET /api/admin/buildings/{id}/lot-owners` | List lot owners with emails, proxy, and financial position |
| `POST /api/admin/buildings/{id}/lot-owners` | Create lot owner; `emails: list[str]` optional (empty = no email) |
| `PATCH /api/admin/lot-owners/{id}` | Update lot number, entitlement, financial position, given/surname |
| `DELETE /api/admin/lot-owners/{id}` | Delete lot owner |
| `POST /api/admin/lot-owners/{id}/emails` | Add email to lot owner; 409 if duplicate within building |
| `DELETE /api/admin/lot-owners/{id}/emails/{email}` | Remove email |
| `PUT /api/admin/lot-owners/{id}/proxy` | Set/replace proxy nomination (`SetProxyRequest: { proxy_email, given_name?, surname? }`) |
| `DELETE /api/admin/lot-owners/{id}/proxy` | Remove proxy nomination |
| `POST /api/admin/buildings/{id}/lot-owners/import` | CSV/Excel upsert by `lot_number`; multiple rows same lot → multiple `LotOwnerEmail` rows; blank email skipped; supports optional `given_name`/`surname` columns |
| `POST /api/admin/buildings/{id}/lot-owners/import-proxies` | CSV/Excel; required columns `Lot#`, `Proxy Email`; blank `Proxy Email` removes nomination |
| `POST /api/admin/buildings/{id}/lot-owners/import-financial-positions` | CSV/Excel; auto-detects simple template (`Lot#`, `Financial Position`) or TOCS Lot Positions Report (multi-section, worst-case across funds) |

**`LotOwnerOut` response schema:**
```json
{
  "id": "uuid",
  "lot_number": "string",
  "emails": ["string"],
  "unit_entitlement": 0,
  "financial_position": "normal|in_arrear",
  "proxy_email": "string|null",
  "given_name": "string|null",
  "surname": "string|null",
  "building_id": "uuid"
}
```

#### Financial position import

`POST /api/admin/buildings/{id}/lot-owners/import-financial-positions` accepts CSV or Excel. Auto-detection: if the first cell of the first line equals `Lot#` (case-insensitive) → simple two-column format. Otherwise → TOCS Lot Positions Report format.

TOCS format: multiple fund sections each starting with a `Lot#` header row; `Closing Balance` column used to determine position. Parsing rules:
- CSV: `$-`, `$ -`, or empty → `normal`; bracketed `(...)` → `normal` (credit); any other value → `in_arrear`
- Excel (numeric): `<= 0` → `normal`; `> 0` → `in_arrear`
- Worst-case across sections: `in_arrear` in any fund → `in_arrear` overall

Unknown lot numbers are skipped (counted in `skipped`). Response: `{"updated": int, "skipped": int}`.

`LotOwner.financial_position` is the live value updated by import. `GeneralMeetingLotWeight.financial_position_snapshot` is captured at AGM creation time and never updated by subsequent imports — the snapshot drives vote eligibility for that AGM.

#### Owner name columns in lot owner import

PRD reference: US-OUN-01

This section covers how `import_lot_owners_from_csv` and `import_lot_owners_from_excel` detect, parse, and store owner names on a per-email basis.

**Column detection (order of preference)**

1. If both `given_name` and `surname` columns are present: use Option A (separate columns — no parsing).
2. Else if a `name` column is present: use Option B (single `Name` column — parse into components).
3. Otherwise: no name data; all `LotOwnerEmail.given_name` and `LotOwnerEmail.surname` remain `null`.

For CSV: detection uses `_normalise_lot_owner_fieldnames`, which already lowercases all headers. The alias map does not need to change — `name`, `given_name`, and `surname` pass through as-is.

For Excel: the existing header detection loop (`headers = [str(h).strip().lower() …]`) already lowercases. Column presence is tested by checking `"name" in headers`, `"given_name" in headers`, `"surname" in headers`. Index variables (`name_idx`, `given_name_idx`, `surname_idx`) are set to `None` when absent.

**Name parsing algorithm (Option B — `Name` column)**

```
def _parse_name(raw: str) -> tuple[str | None, str | None]:
    value = raw.strip()
    if not value:
        return None, None
    parts = value.split()
    if len(parts) == 1:
        return None, parts[0]   # single token → surname only (handles company names)
    return " ".join(parts[:-1]), parts[-1]  # given_name = all but last; surname = last
```

Examples:
- `"Steven Xiwen Sun"` → given_name=`"Steven Xiwen"`, surname=`"Sun"`
- `"Nicole Anne Seils"` → given_name=`"Nicole Anne"`, surname=`"Seils"`
- `"MILSNALF PTY LTD"` → given_name=`"MILSNALF PTY"`, surname=`"LTD"`
- `"Dean"` → given_name=`None`, surname=`"Dean"`
- `""` (blank) → given_name=`None`, surname=`None`

Note: "MILSNALF PTY LTD" splits to given_name=`"MILSNALF PTY"`, surname=`"LTD"` because it has three space-separated tokens. This is intentional — entity names that are a single token (e.g. `"MILSNALF"`) become surname-only.

**Where names are written**

Names are resolved per-row, not per-lot. Each row carries its own `(email, given_name, surname)` triple.

The `lot_data` structure is extended from:
```python
lot_data: dict[str, dict]  # lot_number → {unit_entitlement, financial_position, emails: set}
```
to:
```python
lot_data: dict[str, dict]  # lot_number → {unit_entitlement, financial_position,
                            #               given_name, surname,
                            #               email_entries: list[dict]}
```

Where `email_entries` is a list of `{"email": str, "given_name": str | None, "surname": str | None}` dicts, one per row that had a non-blank email. Order is preserved so the first entry corresponds to the first row (used for lot-level backward compat). Duplicate emails within the same lot are deduplicated — later rows for the same email win (the last row's name overwrites earlier ones for that email).

The old `emails: set` field is replaced by `email_entries: list[dict]`. Deduplication by email is now explicit: when adding an entry, check if the email already exists in `email_entries` for this lot; if so, update the name fields of the existing entry (last-wins).

**Backward-compat lot-level name write**

`LotOwner.given_name` and `LotOwner.surname` continue to be populated from the resolved name of the **first row** for that lot (i.e. `lot_data[lot_number]["given_name"]` and `["surname"]`). No change to `_upsert_lot_owners` for this behaviour beyond referencing `email_entries` for building `LotOwnerEmail` records.

**Blank / missing name — expected outcome**

| Scenario | `LotOwnerEmail.given_name` | `LotOwnerEmail.surname` |
|---|---|---|
| `Name` column present, cell blank | `null` | `null` |
| `Name` column absent entirely | `null` | `null` |
| `given_name`/`surname` columns present, cells blank | `null` | `null` |
| Single-token `Name` value (e.g. `"ACME"`) | `null` | `"ACME"` |

**`_upsert_lot_owners` changes**

The upsert helper currently creates `LotOwnerEmail(lot_owner_id=lo.id, email=email)` from a flat `set`. It must be updated to iterate `email_entries` instead and set `given_name`/`surname` on each record:

```python
# Before (current):
for email in data["emails"]:
    db.add(LotOwnerEmail(lot_owner_id=lo.id, email=email))

# After:
for entry in data["email_entries"]:
    db.add(LotOwnerEmail(
        lot_owner_id=lo.id,
        email=entry["email"],
        given_name=entry["given_name"],
        surname=entry["surname"],
    ))
```

The docstring for `_upsert_lot_owners` must be updated to reflect `email_entries`.

The `total_emails` count at the end uses `len(data["email_entries"])` instead of `len(data["emails"])`.

#### Vote results export (CSV)

`GET /api/admin/general-meetings/{id}` returns `VoterEntry` objects in `voter_lists` per motion category. `VoterEntry` includes:

- `voter_email: str` — for voted lots: the email that authenticated (`BallotSubmission.voter_email`); for absent lots: comma-separated contact emails (all owner emails + proxy email) captured at close time
- `proxy_email: str | null` — set for proxy-voted lots
- `lot_number: str`
- `entitlement: int`

CSV export in `AGMReportView.handleExportCSV()` adds a "Voter Email" column. Proxy rows show `voter_email (proxy: proxy@email.com)`.

Absent `BallotSubmission` records (`is_absent = True`) are created when the meeting is closed, capturing contact emails as a snapshot. The `BallotSubmission` table uses `submitted_lot_owner_ids` (where `is_absent = False`) to distinguish actual votes from absent records.

### Frontend changes

**`BuildingDetailPage.tsx`** (`frontend/src/pages/admin/BuildingDetailPage.tsx`):
- "Edit Building" button → `BuildingEditModal` (role="dialog", pre-fills `name` + `manager_email`, partial update)
- "Archive Building" button (when not archived) → mutually exclusive with
- "Delete Building" button (when archived) → `window.confirm` + calls `DELETE /api/admin/buildings/{id}`, navigates to `/admin/buildings` on success
- `ProxyNominationsUpload` component for bulk proxy import
- `FinancialPositionUpload` component for bulk financial position import
- Lot owner table includes Name column (`${given_name ?? ""} ${surname ?? ""}`.trim())
- "Add Lot Owner" form includes optional `given_name`, `surname` fields; email field optional (blank submits `emails: []`)
- `EditModal` includes proxy section (show/set/remove proxy); minimum-email guard removed (zero emails now valid)

**`AGMReportView.tsx`** (`frontend/src/components/admin/AGMReportView.tsx`):
- CSV export adds "Voter Email" column populated from `VoterEntry.voter_email` and `VoterEntry.proxy_email`

**`frontend/src/api/admin.ts`**:
- `updateBuilding`, `deleteBuilding`, `importProxyNominations`, `setLotOwnerProxy`, `removeLotOwnerProxy`

---

## Security Considerations

- All admin endpoints are behind `require_admin` (session-based auth)
- Deleting a building requires it to be archived first (two-step protection against accidental deletion)
- Building name uniqueness enforced by DB `UNIQUE` constraint
- Email format validation only applies to non-blank emails in the AddForm
- `proxy_email` is stored for audit only; never returned in any voter-facing API

---

## Schema Migration Required

No — `LotOwnerEmail.given_name` and `LotOwnerEmail.surname` columns already exist. No new columns, tables, or constraints are needed for this feature.

Previously recorded migrations (for historical reference):
- `lot_owner_emails` table
- `lot_owners.financial_position`, `lot_owners.given_name`, `lot_owners.surname`
- `lot_proxies` table with `given_name`, `surname`
- `general_meeting_lot_weights.financial_position_snapshot`
- `ballot_submissions.is_absent`, `ballot_submissions.lot_owner_id`, `ballot_submissions.proxy_email`
- `votes.lot_owner_id`

---

## Files to Change

| File | Change |
|---|---|
| `backend/app/services/admin_service.py` | Add `_parse_name` helper; update `import_lot_owners_from_csv` (detect name columns, build `email_entries`); update `import_lot_owners_from_excel` (same); update `_upsert_lot_owners` (iterate `email_entries`, set `given_name`/`surname` on `LotOwnerEmail`) |
| `backend/tests/test_admin_service.py` | Add unit tests covering all three name-column modes (separate columns, Name column, no columns) for both CSV and Excel; cover parse edge cases (blank, single-token, multi-token) |
| `backend/tests/test_admin_routes.py` | Add/update integration tests for the import endpoint to assert `owner_emails[*].given_name` and `owner_emails[*].surname` are populated correctly |

No frontend, schema, or API changes are required.

---

## Test Cases

### Unit tests (`test_admin_service.py`)

| Scenario | Expected |
|---|---|
| CSV with `given_name`/`surname` columns — single row | `LotOwnerEmail.given_name` and `surname` match column values exactly |
| CSV with `given_name`/`surname` columns — blank cells | `given_name=null`, `surname=null` on email record |
| CSV with `Name` column — "Steven Xiwen Sun" | `given_name="Steven Xiwen"`, `surname="Sun"` |
| CSV with `Name` column — "Nicole Anne Seils" | `given_name="Nicole Anne"`, `surname="Seils"` |
| CSV with `Name` column — "ACME" (single token) | `given_name=null`, `surname="ACME"` |
| CSV with `Name` column — blank cell | `given_name=null`, `surname=null` |
| CSV with no name columns | Both name fields `null` on all email records |
| CSV with two rows for same lot (multi-email), each with different `Name` | Each `LotOwnerEmail` record has correct name for its row |
| CSV with two rows same lot same email (duplicate), different names | Last row's name wins; only one `LotOwnerEmail` record created |
| Excel with `Name` column | Same outcomes as CSV equivalents |
| Excel with `given_name`/`surname` columns | Same outcomes as CSV equivalents |
| `examples/Owners.csv` imported against a test building | `LotOwnerEmail` records carry parsed names; `LotOwner.given_name`/`surname` populated from first-row name |
| Lot-level backward compat: first-row name → `LotOwner` | `LotOwner.given_name`/`surname` equal parsed name of row 1; unchanged when second row has different name |

### Integration tests (`test_admin_routes.py`)

| Scenario | Assertion |
|---|---|
| POST import with `Name` column CSV | Response does not error; subsequent `GET /api/admin/buildings/{id}/lot-owners` returns `owner_emails` with `given_name`/`surname` set |
| POST import without name columns | `owner_emails` records have `given_name=null`, `surname=null` |

---

## E2E Test Scenarios

The lot owner import feature is covered by the existing **Admin persona journey** (login → building management → import owners). This feature does not add new UI pages or flows — it changes what the service writes during import, which becomes visible in the admin lot owner table.

### Affected existing E2E specs

The existing Playwright spec that covers lot owner import (`import lot owners from CSV/Excel` scenario in the admin flow) must be updated to assert that after importing `examples/Owners.csv`, the lot owner table shows owner names alongside emails (e.g. `"Nicholas Warren Tassell <ntassell@outlook.com>"`). Do not only add new scenarios — update the existing import spec.

### New E2E scenario: Name parsing end-to-end

**Happy path (Name column):**
1. Admin logs in.
2. Admin navigates to a test building.
3. Admin uploads `examples/Owners.csv` (contains `Name` column, no `given_name`/`surname` columns).
4. Import succeeds; response shows imported count.
5. Admin views the lot owner table.
6. Assert: the lot owner row for lot `"53"` shows `"Nicholas Warren Tassell"` associated with `ntassell@outlook.com`.
7. Assert: the lot owner row for a lot with a blank email has `given_name=null`, `surname=null`.

**Error/edge cases (unit-tested only — no new E2E needed):**
- Single-token name → surname-only (unit test)
- Blank `Name` cell → null names (unit test)
- `given_name`/`surname` columns override `Name` column detection (unit test)
