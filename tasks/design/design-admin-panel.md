# Design: Admin Panel

## Overview

The admin panel provides building and meeting management, in-person vote entry, navigation, pagination, sortable tables, QR code sharing, and co-owner ballot visibility. Admins can enter paper ballot votes on behalf of lot owners during in-person AGMs. The panel is mobile-responsive with a drawer navigation on small screens.

---

## Data Model

### `ballot_submissions` additions

| Column | Type | Notes |
|---|---|---|
| `submitted_by_admin` | BOOLEAN | NOT NULL DEFAULT FALSE; distinguishes admin-entered votes from app-submitted |

---

## API Endpoints

### `POST /api/admin/general-meetings/{id}/enter-votes`

Request:
```json
{
  "entries": [
    {
      "lot_owner_id": "<uuid>",
      "votes": [{"motion_id": "<uuid>", "choice": "yes|no|abstained"}],
      "multi_choice_votes": [{"motion_id": "<uuid>", "option_choices": [...]}]
    }
  ]
}
```

Behaviour:
1. 409 if meeting effective status is not `open`
2. For each `lot_owner_id`: skip (count as `skipped`) if a `BallotSubmission` already exists for that lot — app votes take precedence
3. Call existing `submit_ballot` service logic (all business rules apply: in-arrear ineligibility, option_limit, motion visibility, voting_closed_at)
4. Set `submitted_by_admin = True` on each created `BallotSubmission`

Response: `{ "submitted_count": int, "skipped_count": int }`. 404 if meeting not found, 409 if not open.

### Admin list endpoints with `?name=` filter

`GET /api/admin/buildings?name=<substr>` and `GET /api/admin/general-meetings?name=<substr>` — case-insensitive substring filter on `Building.name` / `GeneralMeeting.title`. Used by E2E helpers to look up entities without fetching the full list.

`GET /api/admin/general-meetings?building_id=<uuid>` — filter meetings to a specific building. Used by E2E helpers to close all open/pending meetings for a building before creating a new one.

`GET /api/admin/buildings/{building_id}` — single-resource endpoint; 404 if not found.

### QR code / sharing

No dedicated endpoint. The admin detail page constructs the voter auth URL as `window.location.origin + "/vote/" + meetingId + "/auth"` client-side. The `ShareSummaryLink` component copies this URL to clipboard and shows it as a clickable link.

---

## Frontend Components

### `AdminVoteEntryPanel.tsx` (`frontend/src/pages/admin/AdminVoteEntryPanel.tsx`)

Two-step flow:

**Step 1 — Lot selection checklist:**
- Fetches lots for the building from the meeting detail
- Filters out lots that already have an app-submitted `BallotSubmission` (`submitted_by_admin = false AND has_submission = true`)
- Renders each lot as a checkbox row: lot number + name (if available)
- "Proceed to vote entry" enabled when ≥1 lot checked

**Step 2 — Vote entry grid:**
- Rows: visible motions (from meeting detail)
- Columns: one per selected lot
- Cell: `AdminVoteCellBinary` (For/Against/Abstain) or `AdminVoteCellMultiChoice` (compact option selector with `option_limit` enforcement)
- In-arrear lots: General and multi-choice motion cells disabled with "Not eligible" label; Special motion cells remain active
- "Submit votes" button → confirmation dialog → `POST /api/admin/general-meetings/{id}/enter-votes`

Mounted as an overlay on `GeneralMeetingDetailPage` when the "Enter In-Person Votes" button is clicked. Button shown only when `meeting.effective_status === "open"`.

### Admin mobile navigation

`AdminLayout.tsx` provides:
- Desktop: fixed sidebar with nav links
- Mobile (`< 768px`): hamburger menu triggers drawer with `admin-nav-drawer` overlay
- Both sidebar and drawer have identical `NavContent` (logos, nav links)
- `useBranding()` applies tenant logo/name in both locations

### Pagination in admin tables

`BuildingTable.tsx`, `GeneralMeetingTable.tsx`, and other admin list tables implement client-side pagination:
- Page size: 20 items
- Page resets to 1 when the `buildings`/`meetings` prop changes length (triggered by filter changes)
- Pagination controls: Previous / Next buttons + current page indicator

### Sortable tables

Admin tables support column sorting via `useSortable` or inline sort state:
- Click column header to sort ascending; click again to sort descending
- Sort indicator (▲ / ▼) in the column header
- Default sort: creation date descending for most tables

### Co-owner ballot visibility

On `GeneralMeetingDetailPage`, the voter lists in the results section show all lot owner IDs that submitted, including proxy submissions. The `VoterEntry.proxy_email` field distinguishes direct submissions from proxy submissions. Admin-entered votes show an "Admin entered" badge in the voter list when `submitted_by_admin = true`.

### QR code sharing

`QRCodeShareLink.tsx` renders a QR code image for the voter auth URL and a "Copy link" button. Uses a lightweight QR library (`qrcode`). The component is collapsed by default and expanded on demand to avoid generating QR codes on every page load.

---

## Key Behaviours

- Admin vote entry uses the same `submit_ballot` service as voter self-service — all business rules are identical
- App-submitted lots are excluded from the admin vote entry lot selection (prevents double-counting)
- `submitted_by_admin` flag persists as an audit record but does not affect tally calculations
- The `?name=` and `?building_id=` query parameters on list endpoints are not exposed in any admin UI — they exist only for E2E helper automation
- Building detail page uses `GET /api/admin/buildings/{id}` (single-resource endpoint, not list-then-filter)

---

## Security Considerations

- `POST /api/admin/general-meetings/{id}/enter-votes` requires `require_admin`
- Admin vote entry skips existing submissions; it cannot overwrite a voter's own ballot
- The admin vote entry UI never bypasses motion visibility or voting window checks
- QR code is client-side only — no new endpoint exposes meeting data

---

## Files

| File | Role |
|---|---|
| `backend/app/models/ballot_submission.py` | `submitted_by_admin` column |
| `backend/app/schemas/admin.py` | `AdminVoteEntryRequest`, `AdminVoteEntryResult`; `submitted_by_admin` on `BallotSubmissionOut` |
| `backend/app/services/admin_service.py` | `enter_votes_for_meeting`; `?name=` and `?building_id=` filter params on list functions |
| `backend/app/routers/admin.py` | `POST /admin/general-meetings/{id}/enter-votes`; `GET /admin/buildings/{id}`; `?name=`/`?building_id=` query params |
| `frontend/src/pages/admin/AdminVoteEntryPanel.tsx` | Lot selection + vote entry grid |
| `frontend/src/pages/admin/AdminLayout.tsx` | Sidebar + mobile drawer navigation |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | "Enter In-Person Votes" button; "Admin entered" badge in voter lists |
| `frontend/src/components/admin/BuildingTable.tsx` | Pagination; page reset on filter |
| `frontend/src/components/admin/GeneralMeetingTable.tsx` | Pagination; sortable columns |
| `frontend/src/components/admin/QRCodeShareLink.tsx` | QR code + copy link |
| `frontend/src/api/admin.ts` | `enterInPersonVotes`, `getBuilding` API functions |
| `frontend/e2e/workflows/helpers.ts` | `seedBuilding` uses `?name=`; `createOpenMeeting`/`createPendingMeeting` use `?building_id=` |
| `frontend/e2e/global-setup.ts` | Name-filtered lookups replace `?limit=1000` scans |

---

---

## Per-Motion Vote Results Download (US-DL-01)

**Status:** Draft

### Overview

Admins on the Results Report section of a General Meeting detail page want to download the vote data for a single motion as a CSV. A full-meeting export button already exists (`↓ Export voter lists (CSV)` in `AGMReportView.tsx`). This feature adds a per-motion download button to each motion card header. All data required for the download is already present in the `MotionDetail` object returned by `GET /api/admin/general-meetings/{id}` — no new backend endpoint is needed.

### Why client-side only

The `GeneralMeetingDetail` response already loads full `voter_lists` (per-lot voter email, lot number, entitlement, proxy status, `submitted_by_admin`) and `tally` data for every motion. A dedicated backend download endpoint would re-query the same data at extra latency cost and add a network round-trip the admin waits through. The existing full-meeting export already uses client-side CSV generation from this same data structure; the per-motion download follows the identical pattern scoped to a single motion.

One field that is NOT currently in the frontend payload is `submitted_at` (the ballot submission timestamp). The acceptance criteria require it. Two approaches are possible:

1. **Add `submitted_at` to the `VoterEntry` shape** — extend `get_general_meeting_detail` to include `submitted_at` from `BallotSubmission.submitted_at` in each voter list entry. This is additive and backward-compatible.
2. **Omit `submitted_at` from the per-motion CSV** — simplest; the full-meeting export also omits it today.

**Decision:** Add `submitted_at` to `VoterEntry` in both the backend service and frontend types. The field is already available in the `voted_submissions` list that builds `lot_owner_to_*` maps. This makes the per-motion CSV more useful for audit purposes and also enriches the existing full-meeting export at no extra DB cost.

### Backend changes

#### `backend/app/services/admin_service.py`

In `get_general_meeting_detail`, extend the per-lot maps built from `voted_submissions`:

```python
lot_owner_to_submitted_at: dict[uuid.UUID, datetime] = {
    sub.lot_owner_id: sub.submitted_at for sub in voted_submissions
}
```

In the `_lots()` helper, include `submitted_at` in each returned dict:

```python
"submitted_at": lot_owner_to_submitted_at.get(lid).isoformat() if lot_owner_to_submitted_at.get(lid) else None,
```

For absent lots, `submitted_at` is the absent record's `submitted_at` (it represents the time the close-meeting sweep created the absent record, which is acceptable for audit; it is distinct from a real vote submission).

#### `backend/app/schemas/admin.py`

Extend `VoterEntryOut` (or equivalent Pydantic schema used for the voter list entries) to include:

```python
submitted_at: datetime | None = None
```

No migration required — `submitted_at` is already on `BallotSubmission` and is only being surfaced in the API response.

### Frontend changes

#### `frontend/src/api/admin.ts`

Extend `VoterEntry` interface:

```typescript
submitted_at?: string | null;  // ISO 8601 UTC
```

#### `frontend/src/components/admin/AGMReportView.tsx`

**Per-motion download function** — add a `handleMotionExportCSV(motion: MotionDetail)` function inside the `AGMReportView` component, following the existing `handleExportCSV` pattern. The function:

1. Builds the CSV header and rows for the single motion only
2. For binary motions: columns `Lot Number,Owner Name,Voter Email,Vote Choice,Entitlement (UOE),Submitted By,Submitted At`
3. For multi-choice motions: columns `Lot Number,Owner Name,Voter Email,Option,Vote Choice,Entitlement (UOE),Submitted By,Submitted At`
4. Triggers a browser download via a temporary `<a>` element with `download` attribute (same pattern as existing `handleExportCSV`)
5. Filename: `<motion_number_or_order>-<title_slug>_results.csv` where `title_slug` is the motion title with non-alphanumeric characters replaced by `_`, truncated to 40 characters, lowercased

**Zero-votes detection** — a motion has zero voter records when all of the following are empty across all categories:
- Binary: `voter_lists.yes`, `voter_lists.no`, `voter_lists.abstained`, `voter_lists.absent`, `voter_lists.not_eligible`
- Multi-choice: all `voter_lists.options_for[*]`, `voter_lists.options_against[*]`, `voter_lists.options_abstained[*]`, `voter_lists.abstained`, `voter_lists.absent`, `voter_lists.not_eligible`

**Button placement** — inside the `.admin-card__header` for each motion card, alongside the existing type badges and the binary expand/collapse toggle. Placed at the end of the header row using `marginLeft: "auto"` only when there is no other `marginLeft: auto` element to its left; if the binary expand toggle already has `marginLeft: auto`, the download button is placed immediately before it (both in a `div` wrapper with `display: flex`, `gap: 8`, `marginLeft: auto`).

The button uses:

```tsx
<button
  type="button"
  className="btn btn--admin"
  onClick={() => handleMotionExportCSV(motion)}
  disabled={hasNoVoters}
  aria-disabled={hasNoVoters}
  aria-label={`Download results CSV for ${motion.title}`}
>
  ↓ CSV
</button>
```

The `btn--admin` class (linen-200 fill, muted text) matches the density of the existing admin utility buttons (e.g. toggle buttons in the admin table) and is visually subordinate to the primary export button above the report.

### Data flow (happy path)

1. Admin opens `/admin/general-meetings/{id}`
2. `GET /api/admin/general-meetings/{id}` returns `GeneralMeetingDetail` including `motions[].voter_lists` with `submitted_at` on each voter entry
3. Admin scrolls to Results Report; each motion card renders a `↓ CSV` button in its header
4. Admin clicks `↓ CSV` on a motion; `handleMotionExportCSV(motion)` runs synchronously in the browser
5. Browser triggers a file download with the motion-scoped CSV; no navigation or loading state required

### CSV column specifications

**Binary motion:**

| Column | Source |
|---|---|
| `Lot Number` | `voter.lot_number` |
| `Owner Name` | `voter.voter_name ?? ""` |
| `Voter Email` | `voter.voter_email ?? ""` — append ` (proxy)` if `voter.proxy_email` is set |
| `Vote Choice` | `For` / `Against` / `Abstained` / `Absent` / `Not eligible` |
| `Entitlement (UOE)` | `voter.entitlement` |
| `Submitted By` | `Admin` if `voter.submitted_by_admin`, else `Voter` |
| `Submitted At` | `voter.submitted_at ?? ""` |

**Multi-choice motion:**

| Column | Source |
|---|---|
| `Lot Number` | `voter.lot_number` |
| `Owner Name` | `voter.voter_name ?? ""` |
| `Voter Email` | `voter.voter_email ?? ""` — append ` (proxy)` if `voter.proxy_email` is set |
| `Option` | `optTally.option_text` — present for option-level rows; `""` for Abstained/Absent/Not eligible rows |
| `Vote Choice` | `For` / `Against` / `Abstained` / `Absent` / `Not eligible` |
| `Entitlement (UOE)` | `voter.entitlement` |
| `Submitted By` | `Admin` if `voter.submitted_by_admin`, else `Voter` |
| `Submitted At` | `voter.submitted_at ?? ""` |

### Security Considerations

No new endpoints are introduced. The download is generated entirely client-side from data already fetched by `GET /api/admin/general-meetings/{id}`, which is guarded by `require_admin`. No additional auth surface is created.

### Files to change

| File | Change |
|---|---|
| `backend/app/services/admin_service.py` | Add `lot_owner_to_submitted_at` map; include `submitted_at` in `_lots()` return dict |
| `backend/app/schemas/admin.py` | Add `submitted_at: datetime \| None = None` to `VoterEntryOut` |
| `frontend/src/api/admin.ts` | Add `submitted_at?: string \| null` to `VoterEntry` interface |
| `frontend/src/components/admin/AGMReportView.tsx` | Add `handleMotionExportCSV()` function; add `↓ CSV` button per motion card header |
| `backend/tests/test_admin_service.py` | Unit tests: `submitted_at` present in voter entries |
| `backend/tests/test_admin_integration.py` | Integration test: verify `submitted_at` in meeting detail response |
| `frontend/src/components/admin/__tests__/AGMReportView.test.tsx` | Unit tests: button renders; disabled when no votes; triggers download; correct CSV content for binary and multi-choice |

### Test cases

**Backend unit tests (`test_admin_service.py`):**
- `get_general_meeting_detail` returns `submitted_at` on each voter entry in `voter_lists.yes`, `.no`, `.abstained`, `.not_eligible`
- Absent voter entries include `submitted_at` from the absent `BallotSubmission.submitted_at`
- Multi-choice per-option voter entries include `submitted_at`

**Backend integration tests (`test_admin_integration.py`):**
- `GET /api/admin/general-meetings/{id}` with real DB — each voter entry in `voter_lists` has a non-null ISO-8601 `submitted_at`

**Frontend unit tests (`AGMReportView.test.tsx`):**
- `↓ CSV` button renders in each motion card header
- Button is disabled when `voter_lists` is empty across all categories
- Button is enabled when at least one voter entry exists
- Clicking enabled button calls `URL.createObjectURL` and triggers `a.click()` (mock DOM)
- Binary motion CSV: correct columns and row content including `submitted_at`
- Multi-choice motion CSV: `Option` column present; correct per-option rows
- In-arrear `not_eligible` rows appear in the CSV
- `submitted_by_admin = true` rows show `Admin` in `Submitted By` column
- Proxy voters: voter email cell appended with ` (proxy)`

### E2E Test Scenarios

No new E2E spec is required for this feature. The button is exercised indirectly during the admin results journey (the existing `agm-33m-workflow.spec.ts` covers the Results Report section). The per-motion download triggers a browser download which Playwright can intercept via `page.waitForEvent("download")` if a targeted E2E scenario is ever added, but the full-meeting export already validates the CSV generation pattern.

**Affected existing E2E specs:** None require modification — the new button does not change any existing layout or data, only adds a new element to each motion card header. The existing admin report assertions pass unchanged.

**Multi-step sequence scenario (for future E2E if needed):** Open meeting → submit votes as voter → close meeting → admin views Results Report → clicks `↓ CSV` on a motion → download received → CSV contains correct lot number, vote choice, entitlement, and `submitted_at` values.

### Vertical slice decomposition

This feature is a single tightly-coupled slice (backend `submitted_at` field + frontend button). The frontend button is useful without the `submitted_at` field (it can simply omit that column), so implementation can proceed in either order, but the backend change is small enough that both should ship in the same PR.

---

## Schema Migration Required

Yes — additive:
- `ballot_submissions.submitted_by_admin` (BOOLEAN NOT NULL DEFAULT FALSE)

No additional migration is required for US-DL-01. The `submitted_at` field is already on `ballot_submissions` and is only newly exposed in the API response.
