# Design: Voter Email Column in Vote Results Export

**Status:** Implemented

## Overview

The vote results export (CSV download from the AGM detail page) currently omits email addresses. Admins need to know which email authenticated and submitted for voted lots, and which contact emails should be chased for lots that did not vote (absent). This feature adds a "Voter Email" column to every row of the CSV export and enriches the underlying `voter_lists` API data with the email information needed to populate it.

## Schema Migration Note

**No Alembic migration is required.** All required data already exists in the database:
- `ballot_submissions.voter_email` — the email that authenticated and submitted
- `ballot_submissions.proxy_email` — set when a proxy submitted on behalf of the lot
- `lot_owner_emails` — all registered emails for a lot owner
- `lot_proxies.proxy_email` — nominated proxy for a lot owner

---

## Current Export Format

`AGMReportView.handleExportCSV()` builds a flat CSV with this header row:

```
Motion,Category,Lot Number,Entitlement (UOE)
```

For each motion it iterates `voter_lists[cat]` (yes / no / abstained / absent / not_eligible) and emits one row per `VoterEntry`. `VoterEntry` currently contains:

| Field | Source |
|---|---|
| `voter_email` | First email in `lot_info[lid]["emails"]` (a `LotOwnerEmail` address, NOT the auth email) |
| `lot_number` | `LotOwner.lot_number` |
| `entitlement` | `GeneralMeetingLotWeight.unit_entitlement_snapshot` |

The `voter_email` field in `VoterEntry` is **misleading for voted rows**: it is the first registered owner email, not the email that actually authenticated and cast the ballot. For absent rows it is still the first registered owner email, but all registered emails and the proxy email are needed.

The `voter_email` field is present in the API response schema (`VoterEntry`) but is **not included in the CSV** — the `handleExportCSV` function only uses `v.lot_number` and `v.entitlement`.

---

## Data Sources by Scenario

| Scenario | Who voted | "Voter Email" column value |
|---|---|---|
| Direct vote | Lot owner email authenticated and submitted | `ballot_submissions.voter_email` |
| Proxy vote | Proxy email authenticated and submitted | `ballot_submissions.voter_email` (the proxy's email) + optionally annotated "(proxy)" |
| Absent lot | No submission | All `lot_owner_emails` addresses + `lot_proxies.proxy_email` if set, comma-separated |
| Absent lot, no emails | No submission, no registered emails | Empty string / blank cell |

For absent lots the intention is to show all contact points so the admin can follow up. Owner emails and the proxy email are all relevant.

---

## Backend Changes

### 0. Schema migration — add `is_absent` to `BallotSubmission`

A new boolean column `is_absent` (default `false`, server default `'false'`) is added to `ballot_submissions`. This distinguishes actual voter submissions from absent-lot records created at close time.

Migration file: `backend/alembic/versions/0b8d45b3ee02_add_is_absent_to_ballot_submissions.py`

### 1. Create absent BallotSubmission records on close

Location: `backend/app/services/admin_service.py`, function `close_general_meeting`.

When closing a meeting, after marking it as closed, create `BallotSubmission` records for every eligible lot that did NOT vote:

- Query `GeneralMeetingLotWeight` for all eligible `lot_owner_id`s
- Query existing `BallotSubmission` where `is_absent=False` for voted lot_owner_ids
- Absent = eligible - voted
- Batch-load owner emails and proxy emails for absent lots (two batched IN queries)
- For each absent lot:
  - `voter_email` = comma-separated dedup of all owner emails + proxy email (if proxy not already in owner emails)
  - `proxy_email` = `LotProxy.proxy_email` if set
  - `is_absent = True`

This captures contact email data as a snapshot at close time.

### 2. Update `get_general_meeting_detail`

Location: `backend/app/services/admin_service.py`, function `get_general_meeting_detail`.

- `submitted_lot_owner_ids` = BallotSubmissions where `is_absent=False` (actual votes only)
- `total_submitted` = count of non-absent submissions
- `absent_submissions` = dict of `lot_owner_id` → BallotSubmission where `is_absent=True`
- `absent_ids` (when closed) = keys of `absent_submissions`
- Modify `_lots()` to accept a `category` parameter:
  - **Voted categories** (yes / no / abstained / not_eligible): `voter_email` from `lot_owner_to_email`, `proxy_email` from `lot_owner_to_proxy_email`
  - **Absent category**: `voter_email` from the absent BallotSubmission's `voter_email` field

### 3. Extend `VoterEntry` schema

Location: `backend/app/schemas/admin.py`, class `VoterEntry`.

Add an optional `proxy_email` field so the frontend can distinguish direct vs proxy votes without string parsing:

```python
class VoterEntry(BaseModel):
    voter_email: str      # existing — now: auth email for voted rows; all contact emails (comma-sep) for absent
    lot_number: str       # existing — unchanged
    entitlement: int      # existing — unchanged
    proxy_email: str | None = None   # NEW — set only for voted proxy rows
```

This is backward-compatible (new optional field, existing consumers see `None`).

### 3. No new endpoints

No new API routes are needed. The enriched data flows through the existing `GET /api/admin/general-meetings/{id}` endpoint via the `voter_lists` field on each `MotionDetail`.

---

## Frontend Changes

### 1. Update `VoterEntry` TypeScript type

Location: `frontend/src/api/admin.ts`, interface `VoterEntry`.

Add:
```typescript
export interface VoterEntry {
  voter_email?: string;      // existing (optional — was already optional in TS)
  lot_number?: string;       // existing
  entitlement: number;       // existing
  proxy_email?: string | null;  // NEW
}
```

### 2. Update `handleExportCSV` in `AGMReportView`

Location: `frontend/src/components/admin/AGMReportView.tsx`.

Change the header row and data row format:

**Current header:**
```
Motion,Category,Lot Number,Entitlement (UOE)
```

**New header:**
```
Motion,Category,Lot Number,Entitlement (UOE),Voter Email
```

**Current data row:**
```typescript
rows.push(`"${motionLabel}","${CATEGORY_LABELS[cat]}","${v.lot_number}",${v.entitlement}`);
```

**New data row:**
```typescript
const emailCell = v.proxy_email
  ? `${v.voter_email || ""} (proxy: ${v.proxy_email})`
  : (v.voter_email || "");
rows.push(`"${motionLabel}","${CATEGORY_LABELS[cat]}","${v.lot_number}",${v.entitlement},"${emailCell.replace(/"/g, '""')}"`);
```

For absent rows `v.voter_email` already contains the comma-separated contact emails assembled by the backend; `v.proxy_email` will be `null`. The frontend does not need to branch on the category — it always renders the `voter_email` field, which is populated appropriately by the backend for each category.

---

## Key Design Decisions

### Why enrich in the backend rather than the frontend?

The frontend already receives `voter_lists` from `GET /api/admin/general-meetings/{id}`. The backend already has `BallotSubmission.voter_email` in scope during `get_general_meeting_detail`. Enriching in the backend keeps the frontend dumb (it just renders what it receives) and means the data is correct in the API response — useful if other consumers (e.g. the email report template) ever need it.

### Why use the submission `voter_email`, not the lot owner `emails` list, for voted rows?

`BallotSubmission.voter_email` is the email that actually authenticated — it is the audit trail. The lot owner `emails` list may contain multiple addresses and we do not know which one the person used. The architectural note in CLAUDE.md explicitly says "`voter_email` is retained on both tables for audit only."

### Why comma-separate absent emails in a single field rather than one row per email?

The existing export is one row per lot per motion. Changing to one row per email per lot per motion would inflate row count and break any post-processing that expects one row per lot. Comma-separating preserves the row shape. Admins exporting this data are expected to be comfortable with comma-separated email lists in a single cell.

### Why not annotate proxy with a separate column?

A single "Voter Email" column is sufficient and keeps the CSV compact. For proxy-voted lots, appending "(proxy: proxy@email.com)" in the email cell conveys the information clearly. The `proxy_email` field is still available on `VoterEntry` for UI rendering if needed in the future.

### PII / Security considerations

- The `GET /api/admin/general-meetings/{id}` endpoint is already protected by `require_admin` (session-based auth, checked in the router via `dependencies=[Depends(require_admin)]`). No change to auth is needed.
- The CSV download is performed entirely client-side from data already in the authenticated admin's browser session. No new endpoint is exposed.
- Email addresses are only ever returned to the admin-authenticated session, not to voter sessions. The voter-facing endpoints (`POST /api/auth/verify`, `POST /api/agm/{id}/submit`) do not use `VoterEntry` or `voter_lists`.

---

## Data Flow (Happy Path)

1. Admin navigates to `/admin/general-meetings/{id}` — the page calls `GET /api/admin/general-meetings/{id}`.
2. `get_general_meeting_detail` runs:
   a. Loads `BallotSubmission` records → builds `lot_owner_to_email` (auth email) and `lot_owner_to_proxy_email` (proxy email from submission).
   b. For absent lots, issues a single batched `SELECT` on `LotProxy` for all absent `lot_owner_id`s → builds `absent_lot_proxy`.
   c. For each motion, `_lots()` is called per category. For voted categories it uses `lot_owner_to_email` + `lot_owner_to_proxy_email`; for absent it uses `lot_info[lid]["emails"]` + `absent_lot_proxy`.
   d. Each `VoterEntry` in `voter_lists` now carries `voter_email` (the auth/contact email) and `proxy_email` (set only for proxy-voted rows, `None` otherwise).
3. The frontend renders the page — the existing tally table is unchanged. The "Export voter lists (CSV)" button is now present.
4. Admin clicks the button. `handleExportCSV` iterates `voter_lists` and builds a CSV with a "Voter Email" column populated from `v.voter_email` and `v.proxy_email`.
5. Browser triggers a file download.

---

## Vertical Slice Decomposition

This feature touches backend and frontend, but they are tightly coupled through the `VoterEntry` shape:

- **Slice 1 — Backend enrichment**: extend `_lots()` and `VoterEntry`. Independently testable via unit tests on `get_general_meeting_detail` and integration tests on `GET /api/admin/general-meetings/{id}`. No frontend changes required to verify.
- **Slice 2 — Frontend CSV column**: update `handleExportCSV` and the `VoterEntry` TS type to render the new column. Can be developed against a mock that already returns `proxy_email`.

These can be parallelised but Slice 2 depends on the backend contract from Slice 1 being finalised first. Recommend implementing sequentially (backend first, then frontend) given the small scope.

---

## Affected Persona Journeys

This feature touches the **Admin** journey (login → building/meeting management → report viewing → close meeting). Specifically the "report viewing" step gains a richer CSV export.

The existing E2E spec at `frontend/e2e/admin/admin-general-meetings.spec.ts` must be updated — not just new scenarios added. The existing test `"General Meeting detail page shows Results Report section"` should be extended or a new test added in the same describe block to verify the export button exists and the CSV contains the new column.

---

## E2E Test Scenarios

All new scenarios belong in `frontend/e2e/admin/admin-general-meetings.spec.ts` within a new `describe` block: `"Admin General Meetings — voter email CSV export"`.

### Setup (beforeAll)

Seed:
- One building with manager email
- Three lot owners:
  - Lot A: `owner-a@test.com`, proxy: `proxy-a@test.com`
  - Lot B: `owner-b1@test.com`, `owner-b2@test.com` (two emails, no proxy)
  - Lot C: `owner-c@test.com` (will be absent)
- One open meeting with one general motion

Vote scenarios (via API):
- Lot A: proxy `proxy-a@test.com` authenticates and submits → `BallotSubmission.voter_email = "proxy-a@test.com"`, `proxy_email = "proxy-a@test.com"`
- Lot B: `owner-b1@test.com` authenticates and submits → `BallotSubmission.voter_email = "owner-b1@test.com"`, `proxy_email = null`
- Lot C: no submission (absent after close)

Close the meeting.

### Scenario 1 — Happy path: CSV contains Voter Email column header

Navigate to `/admin/general-meetings/{meetingId}`, click "Export voter lists (CSV)", assert the downloaded file's first line contains `Voter Email` as a column header.

Because Playwright cannot easily inspect downloaded file contents, implement this by:
- Intercepting the download and reading the blob URL's text content, OR
- Verifying via a unit test on `handleExportCSV` (Vitest + RTL), and using the E2E test only to confirm the button exists and triggers a download.

Prefer the unit test approach for CSV content assertions; use E2E only for button visibility and download trigger.

### Scenario 2 — Direct vote: voter email is the auth email

In the `voter_lists` API response (not the CSV), assert that Lot B's `VoterEntry` in the "yes" or "no" list has `voter_email = "owner-b1@test.com"` and `proxy_email = null`.

### Scenario 3 — Proxy vote: proxy email is shown

Assert that Lot A's `VoterEntry` has `voter_email = "proxy-a@test.com"` and `proxy_email = "proxy-a@test.com"` (or whichever non-null value reflects the proxy submission).

### Scenario 4 — Absent lot: all contact emails shown

Assert that Lot C's `VoterEntry` in the "absent" list has `voter_email` containing `"owner-c@test.com"`. If Lot C had a proxy nomination, assert that email is also present in `voter_email` (comma-separated).

### Scenario 5 — Absent lot with no emails

Seed an additional lot with no registered emails, no proxy. After close, assert its absent `VoterEntry` has `voter_email = ""` (empty string, not an error).

### Scenario 6 — Open meeting: absent list is empty

Before closing the meeting, assert that the absent `voter_lists` array is empty (existing behaviour, regression guard).

### Unit test scenarios (Vitest — `AGMReportView`)

These are the primary assertions on CSV content:

- Render `AGMReportView` with mock `motions` data containing voted and absent entries with known `voter_email` / `proxy_email` values. Click "Export voter lists (CSV)". Capture the generated blob content.
- Assert header row contains `Voter Email`.
- Assert direct-vote row contains the auth email.
- Assert proxy-vote row contains the auth email with `(proxy: ...)` annotation.
- Assert absent row contains the comma-separated contact emails.
- Assert absent row with no emails has a blank Voter Email cell.

### Integration test scenarios (pytest — `test_admin_service.py`)

In `get_general_meeting_detail` tests:

- Voted lot: `VoterEntry.voter_email` equals `BallotSubmission.voter_email`, not the first `LotOwnerEmail`.
- Proxy-voted lot: `VoterEntry.proxy_email` equals `BallotSubmission.proxy_email`.
- Absent lot with multiple owner emails + proxy nomination: `VoterEntry.voter_email` is comma-separated union; `VoterEntry.proxy_email` is `None`.
- Absent lot with no emails and no proxy: `VoterEntry.voter_email` is `""`.
- Open meeting: absent list is empty (no proxy query issued).
