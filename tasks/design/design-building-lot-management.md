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

Yes — additive migrations:
- `lot_owner_emails` table
- `lot_owners.financial_position`, `lot_owners.given_name`, `lot_owners.surname`
- `lot_proxies` table with `given_name`, `surname`
- `general_meeting_lot_weights.financial_position_snapshot`
- `ballot_submissions.is_absent`, `ballot_submissions.lot_owner_id`, `ballot_submissions.proxy_email`
- `votes.lot_owner_id`
