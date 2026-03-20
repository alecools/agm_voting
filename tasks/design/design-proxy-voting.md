# Technical Design: Proxy Voting

## Overview

Proxy voting allows a nominated person (the proxy) to authenticate with their own email address and cast votes on behalf of one or more lot owners who cannot attend the AGM. Proxy nominations are stored at the building level and persist across all AGMs for that building until explicitly changed or removed. The feature also adds a standalone financial position import so admins can bulk-update arrear status without re-importing the full lot owner list.

---

## Database Changes

### New table: `lot_proxies`

Migration: `c8337fb36d23_add_lot_proxy_table_and_ballot_.py`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, default `uuid4` |
| `lot_owner_id` | UUID | FK → `lot_owners.id` ON DELETE CASCADE, NOT NULL |
| `proxy_email` | String | NOT NULL |
| `created_at` | DateTime (tz) | server_default `now()`, NOT NULL |

Table-level constraints:
- `UniqueConstraint("lot_owner_id", name="uq_lot_proxies_lot_owner_id")` — one active proxy per lot at a time
- `Index("ix_lot_proxies_proxy_email", "proxy_email")` — fast lookup during authentication

### Modified table: `ballot_submissions`

Column added in the same migration:

| Column | Type | Constraints |
|---|---|---|
| `proxy_email` | String | nullable, default NULL |

Set to the authenticated voter's email when they submit a vote as proxy; NULL when they vote for a lot they directly own. Internal audit trail only — not exposed in any API response or UI.

### `LotOwner` model — relationship added

`lot_owner.lot_proxy` is a `uselist=False` one-to-one relationship to `LotProxy` with `cascade="all, delete-orphan"`. No new columns on `lot_owners`.

---

## Backend Changes

### New/Modified Models

**`LotProxy`** (`backend/app/models/lot_proxy.py`):

```python
class LotProxy(Base):
    __tablename__ = "lot_proxies"
    id: Mapped[uuid.UUID]
    lot_owner_id: Mapped[uuid.UUID]   # FK → lot_owners.id CASCADE
    proxy_email: Mapped[str]
    created_at: Mapped[datetime]
```

**`BallotSubmission`** (`backend/app/models/ballot_submission.py`) — new field:

```python
proxy_email: Mapped[str | None]  # nullable; set when ballot submitted by proxy
```

**`LotOwner`** (`backend/app/models/lot_owner.py`) — new relationship:

```python
lot_proxy: Mapped["LotProxy | None"]  # uselist=False, cascade all/delete-orphan
```

### New/Modified API Endpoints

All admin endpoints are under `/api/admin` and require admin authentication.

#### Proxy nomination import

```
POST /api/admin/buildings/{building_id}/lot-owners/import-proxies
Content-Type: multipart/form-data (file: .csv or .xlsx)

Response 200:
{
  "upserted": int,
  "removed": int,
  "skipped": int
}
```

Accepts CSV or Excel. Required columns (case-insensitive): `Lot#`, `Proxy Email`. Blank `Proxy Email` removes the existing nomination. Unknown lot numbers are skipped with a warning (not a fatal error). Missing required headers → 422.

#### Financial position import

```
POST /api/admin/buildings/{building_id}/lot-owners/import-financial-positions
Content-Type: multipart/form-data (file: .csv or .xlsx)

Response 200:
{
  "updated": int,
  "skipped": int
}
```

Accepts both a simple template CSV (`Lot#`, `Financial Position`) and the TOCS Lot Positions Report CSV (auto-detected by whether the first line starts with `Lot#`). Accepted values: `Normal` → `normal`, `In Arrear` / `in_arrear` → `in_arrear` (case-insensitive). Invalid values → 422 listing all offending rows.

#### Individual proxy management (inline on lot owner edit modal)

```
PUT  /api/admin/lot-owners/{lot_owner_id}/proxy
Body: { "proxy_email": "<email>" }   # non-empty, validated by SetProxyRequest
Response 200: LotOwnerOut

DELETE /api/admin/lot-owners/{lot_owner_id}/proxy
Response 200: LotOwnerOut
Response 404: if no proxy nomination exists for this lot owner
```

`SetProxyRequest` validates that `proxy_email` is non-empty (no format validation beyond that — any email string is accepted).

#### Lot owner detail — `proxy_email` included

`GET /api/admin/lot-owners/{id}` and all endpoints that return `LotOwnerOut` now include `proxy_email: str | null`. The field is populated by a separate `SELECT` against `lot_proxies` for each lot owner returned.

**`LotOwnerOut` schema** (relevant fields):

```python
class LotOwnerOut(BaseModel):
    id: uuid.UUID
    lot_number: str
    unit_entitlement: int
    financial_position: str
    emails: list[str]
    proxy_email: str | None = None
    building_id: uuid.UUID
```

### Auth Resolution Logic

`POST /api/auth/request-otp` and `POST /api/auth/verify` both perform the same two-source lookup:

1. **Direct owners**: `SELECT LotOwnerEmail JOIN LotOwner WHERE email = :email AND building_id = :building_id`
2. **Proxy lots**: `SELECT LotProxy JOIN LotOwner WHERE proxy_email = :email AND building_id = :building_id`

For `request-otp`: if either set is non-empty, the email is considered "known" and an OTP is generated and sent. This is enumeration-safe — the endpoint always returns `{"sent": true}` regardless of whether the email was found.

For `verify`:
- The union of both sets is computed in Python (`direct_lot_owner_ids | proxy_lot_owner_ids`).
- If the union is empty, raise 401 "Email address not found for this building".
- For each `lot_owner_id` in the union: `is_proxy = lot_owner_id not in direct_lot_owner_ids` — direct ownership takes precedence, so if the voter is both a direct owner and a proxy for the same lot, `is_proxy=False`.
- `already_submitted` is checked per lot via `BallotSubmission` keyed on `(general_meeting_id, lot_owner_id)`.
- The `lots` list is sorted by `lot_number` for consistent UI ordering.

**OTP flow note**: The OTP is keyed on `(email, general_meeting_id)` — not on lot ownership. A pure-proxy voter (no lots in the building) can request and receive an OTP and authenticate successfully, as long as at least one `LotProxy` record maps their email to a lot in the building.

### Ballot Submission with Proxy

`submit_ballot` in `voting_service.py` validates ownership and determines `proxy_email` per lot:

```python
for lot_owner_id in lot_owner_ids:
    # Check direct ownership first
    is_direct = LotOwnerEmail where lot_owner_id = X AND email = voter_email
    if is_direct:
        proxy_email_by_lot[lot_owner_id] = None
    else:
        # Check proxy nomination
        is_proxy = LotProxy where lot_owner_id = X AND proxy_email = voter_email
        if not is_proxy:
            raise 403 "Lot owner does not belong to authenticated voter"
        proxy_email_by_lot[lot_owner_id] = voter_email
```

A `BallotSubmission` is then created per lot:

```python
BallotSubmission(
    general_meeting_id=...,
    lot_owner_id=lot_owner_id,
    voter_email=voter_email,
    proxy_email=proxy_email_by_lot.get(lot_owner_id),  # None or voter's email
    submitted_at=datetime.now(UTC),
)
```

The `proxy_email` column is stored in the database but never returned in any API response.

The `get_my_ballot` function (confirmation screen) also performs the same two-source union query to identify which lots belong to the authenticated voter, ensuring proxy lots appear in the post-submission confirmation.

---

## Frontend Changes

### New/Modified Components and Pages

#### `ProxyNominationsUpload` (`frontend/src/components/admin/ProxyNominationsUpload.tsx`)

New component rendered on `BuildingDetailPage`. Provides a hidden `<input type="file">` accepting `.csv`, `.xlsx`, `.xls`. On file selection it immediately calls `importProxyNominations(buildingId, file)` via React Query `useMutation`. On success it displays: "Import complete: N upserted, N removed, N skipped." On error it shows the HTTP error message inline. After success it calls `onSuccess()` to invalidate the lot-owners query cache.

#### `FinancialPositionUpload` (`frontend/src/components/admin/FinancialPositionUpload.tsx`)

New component with the same pattern as `ProxyNominationsUpload`, pointing at the financial positions import endpoint.

#### `BuildingDetailPage` (`frontend/src/pages/admin/BuildingDetailPage.tsx`)

Modified to render `ProxyNominationsUpload` and `FinancialPositionUpload` below the existing `LotOwnerCSVUpload` card. Both receive `buildingId` and the shared `handleCSVSuccess` callback.

#### `LotOwnerForm` / `EditModal` (`frontend/src/components/admin/LotOwnerForm.tsx`)

The `EditModal` (rendered when editing an existing lot owner) now includes a "Proxy" section:

- If `lotOwner.proxy_email` is set: shows the email string and a "Remove proxy" button that calls `DELETE /api/admin/lot-owners/{id}/proxy`.
- If not set: shows a text input (`aria-label="Set proxy email"`) and "Set proxy" button that calls `PUT /api/admin/lot-owners/{id}/proxy`.
- Client-side validation: empty or malformed email shows an inline error without making an API call.
- Server errors are displayed inline below the proxy section.
- The `proxyModified` flag allows the modal to close with "no changes detected" suppressed if only the proxy was changed.

#### `VotingPage` (`frontend/src/pages/vote/VotingPage.tsx`)

Modified to read `is_proxy` from each `LotInfo` and render proxy-specific UI:

- **Multi-lot sidebar** (`showSidebar = allLots.length > 1`): renders a checkbox list per lot. Proxied lots show a `<span class="lot-selection__badge lot-selection__badge--proxy">via Proxy</span>` badge. The sidebar also includes "Select Proxy Lots" and "Select Owned Lots" shortcut buttons when `hasProxyLot` is true.
- **Single-lot proxy voter** (`!isMultiLot && allLots[0].is_proxy`): renders a compact `lot-selection--inline` strip above the motions with just the lot number and "via Proxy" badge. No sidebar is shown.
- **Own lots** (whether single or multi): no proxy badge.
- In-arrear badge is rendered independently of proxy status.
- Already-submitted lots remain greyed out with their badges visible.

`LotInfo` items are loaded from `sessionStorage` key `meeting_lots_info_${meetingId}` (written by `AuthPage`/`LotSelectionPage` after successful auth).

### API Integration

**`frontend/src/api/admin.ts`**:

```typescript
export interface ProxyImportResult { upserted: number; removed: number; skipped: number; }

export async function importProxyNominations(buildingId: string, file: File): Promise<ProxyImportResult>
// POST /api/admin/buildings/{buildingId}/lot-owners/import-proxies (multipart)

export async function setLotOwnerProxy(lotOwnerId: string, proxyEmail: string): Promise<LotOwner>
// PUT /api/admin/lot-owners/{lotOwnerId}/proxy  body: { proxy_email }

export async function removeLotOwnerProxy(lotOwnerId: string): Promise<LotOwner>
// DELETE /api/admin/lot-owners/{lotOwnerId}/proxy
```

**`frontend/src/api/voter.ts`** — `LotInfo` interface gains:

```typescript
export interface LotInfo {
  lot_owner_id: string;
  lot_number: string;
  financial_position: string;
  already_submitted: boolean;
  is_proxy: boolean;   // added
}
```

**`frontend/src/types/index.ts`** — `LotOwner` type gains:

```typescript
proxy_email: string | null;
```

---

## Key Design Decisions

**One proxy per lot at a time, not per AGM.** The `UNIQUE` constraint on `lot_proxies.lot_owner_id` enforces this at the DB level. Proxy nominations are building-scoped and remain in effect for all future AGMs until removed. This simplifies admin workflow — one file upload covers all upcoming meetings.

**Union query rather than a view or join.** Auth performs two separate `SELECT` queries (one for direct owners via `LotOwnerEmail`, one for proxies via `LotProxy`) and merges the result sets in Python. This keeps the query logic readable and avoids a complex UNION SQL query with different column semantics across branches.

**Direct ownership takes precedence.** When the same email appears in both `LotOwnerEmail` and `LotProxy` for the same lot (edge case), `is_proxy=False` is returned. This is computed as `lot_owner_id not in direct_lot_owner_ids` in the auth handler.

**Proxy authorisation checked at auth time, not at submit time.** Per the PRD open questions: if a proxy nomination is removed after the voter has authenticated, the in-flight session remains valid and the vote is accepted. The vote submission does re-verify ownership per lot (direct or proxy) before writing `BallotSubmission`, but the session itself is not invalidated.

**CSV upsert by lot_number.** Import loads all `LotOwner` records for the building into a `dict[lot_number → LotOwner]`, then processes rows one by one. Unknown lot numbers are skipped with a `logger.warning`. Blank `Proxy Email` triggers deletion of the existing `LotProxy` record if present (increment `removed`). Non-blank triggers create-or-update (increment `upserted`).

**Financial position import auto-detects TOCS format.** The CSV parser (`_parse_financial_position_csv_rows`) checks whether the first non-empty line starts with `Lot#` to distinguish the simple template from the TOCS Lot Positions Report. The TOCS format has fund-section headers and uses parenthesised amounts to indicate credit balances (mapped to `normal`); positive amounts indicate arrears (mapped to `in_arrear`). The Excel parser mirrors this logic with a separate TOCS-detection path.

**`proxy_email` on `BallotSubmission` is audit-only.** It is set in `submit_ballot` and stored in the DB, but is never serialised into any API response schema and never displayed in the admin report UI.

**`SetProxyRequest` validates non-empty but not email format.** The backend schema only rejects empty strings — any non-empty string is accepted as a proxy email. The frontend's `LotOwnerForm` applies a local regex check before calling the API, but the backend does not.

---

## Data Flow

```
Admin uploads proxy CSV
  → POST /api/admin/buildings/{id}/lot-owners/import-proxies
  → _parse_proxy_csv_rows / _parse_proxy_excel_rows
  → import_proxies(building_id, rows, db)
      for each row: upsert or delete LotProxy record
  → Response: { upserted, removed, skipped }

Voter navigates to building/meeting
  → POST /api/auth/request-otp  (email + general_meeting_id)
      checks LotOwnerEmail OR LotProxy for this building → email known → OTP stored + emailed
  → Voter enters OTP
  → POST /api/auth/verify  (email + code + general_meeting_id)
      validates OTP
      SELECT LotOwnerEmail JOIN LotOwner → direct_lot_owner_ids
      SELECT LotProxy JOIN LotOwner → proxy_lot_owner_ids
      union → all_lot_owner_ids
      for each: is_proxy = not in direct set; fetch financial_position; check already_submitted
      → Response: { lots: [{ lot_owner_id, lot_number, financial_position, already_submitted, is_proxy }], ... }
      → Set meeting_session cookie

Frontend (LotSelectionPage / VotingPage)
  → Stores lots in sessionStorage["meeting_lots_info_<meetingId>"]
  → VotingPage renders "via Proxy" badge on lots where is_proxy=true
  → Multi-lot proxy voter sees "Select Proxy Lots" / "Select Owned Lots" shortcut buttons
  → Single-lot proxy voter sees inline lot strip with "via Proxy" badge

Voter submits ballot
  → POST /api/general-meeting/{id}/submit
      body: { lot_owner_ids: [...], votes: [...] }
  → submit_ballot:
      for each lot_owner_id: verify voter_email is direct owner OR proxy
        → proxy_email_by_lot[id] = None (direct) or voter_email (proxy)
      → insert Vote rows (per lot, per motion)
      → insert BallotSubmission(proxy_email=proxy_email_by_lot[id]) per lot
  → Navigate to /vote/{meetingId}/confirmation
```

---

## PRD Stories — Implementation Status

| Story | Status | Notes |
|---|---|---|
| US-PX01: `lot_proxy` table + `BallotSubmission.proxy_email` | Implemented | Migration `c8337fb36d23` |
| US-PX02: Import proxy nominations via CSV/Excel | Implemented | `POST .../import-proxies` |
| US-PX03: Import lot financial positions via CSV/Excel | Implemented | `POST .../import-financial-positions`; supports both simple template and TOCS format |
| US-PX04: Auth resolves proxy lots | Implemented | `POST /api/auth/verify` union query |
| US-PX05: Lot selection UI shows proxy label | Implemented | `VotingPage` sidebar + inline strip; "via Proxy" badge |
| US-PX06: Proxy audit trail on ballot submission | Implemented | `BallotSubmission.proxy_email` set in `submit_ballot` |
| US-PX07: Admin lot owner detail shows proxy | Implemented | `GET /api/admin/lot-owners/{id}` returns `proxy_email`; shown in `LotOwnerTable` |
| US-PX08: Edit proxy inline on lot owner edit screen | Implemented | `EditModal` in `LotOwnerForm`; `PUT`/`DELETE .../proxy` endpoints |
