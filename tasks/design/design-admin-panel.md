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

## Schema Migration Required

Yes — additive:
- `ballot_submissions.submitted_by_admin` (BOOLEAN NOT NULL DEFAULT FALSE)
