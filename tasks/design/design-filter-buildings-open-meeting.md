# Design: Filter Building List to Open Meetings Only

**Status:** Implemented

## Overview

The voter home page (`BuildingSelectPage`) shows a building dropdown populated by `GET /api/buildings`. Currently this returns every non-archived building, including buildings that have no meetings at all or only closed/past meetings. A voter who selects such a building sees an empty or purely-closed meeting list and has no actionable path — they cannot vote.

This change filters `GET /api/buildings` to return only buildings that have at least one meeting whose **effective status** is `"open"`. A building with only closed, pending, or expired meetings is excluded.

---

## Database Changes

None. No new tables, columns, or migrations are required. All data needed for the filter already exists in the `general_meetings` table.

**Schema migration needed: no.**

---

## Backend Changes

### Modified endpoint

**File:** `backend/app/routers/public.py`
**Function:** `list_buildings` — `GET /api/buildings`

**Current query:**
```python
select(Building)
    .where(Building.is_archived == False)
    .order_by(Building.name)
```

**New query** — add a correlated `EXISTS` subquery that checks for at least one meeting whose effective status is `open`:

```python
from sqlalchemy import exists

select(Building)
    .where(Building.is_archived == False)
    .where(
        exists(
            select(GeneralMeeting.id)
            .where(GeneralMeeting.building_id == Building.id)
            .where(GeneralMeeting.status != GeneralMeetingStatus.closed)
            .where(GeneralMeeting.voting_closes_at > func.now())
            .where(GeneralMeeting.meeting_at <= func.now())
        )
    )
    .order_by(Building.name)
```

**Why this subquery correctly mirrors `get_effective_status`:**

`get_effective_status` in `backend/app/models/general_meeting.py` returns `"open"` when all three of these hold:
1. Stored `status` is not `"closed"` (manually closed meetings stay closed)
2. `voting_closes_at` is in the future (not yet expired)
3. `meeting_at` is in the past or present (the meeting has started)

The subquery replicates all three conditions in SQL:
- `status != 'closed'` — condition 1
- `voting_closes_at > now()` — condition 2
- `meeting_at <= now()` — condition 3

A building with a `pending` meeting (future `meeting_at`) is therefore excluded — `pending` meetings are not yet open for voting.

**New imports needed in `public.py`:**
- `from sqlalchemy import exists, func` (add `exists` and `func` to the existing `from sqlalchemy import select` import)
- `from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus, get_effective_status` (add `GeneralMeetingStatus` to existing import)

No changes to the response schema — `BuildingOut` shape is unchanged.

---

## Frontend Changes

No frontend changes are required. `BuildingSelectPage.tsx` calls `fetchBuildings()` which hits `GET /api/buildings` and renders whatever the API returns. With the backend filter in place, only buildings with open meetings will be present in the dropdown. The page already handles an empty list gracefully (the dropdown renders with no options).

The existing `GeneralMeetingList` component already handles the per-building meeting list showing open/closed states — this is unaffected.

---

## Key Design Decisions

### Why filter in the backend rather than the frontend?

Filtering server-side keeps the logic in one place and avoids sending unnecessary data to the client. The alternative — fetching all buildings and then filtering on the client based on the meetings list — would require the frontend to fetch meetings for every building in parallel before it can render the dropdown, dramatically increasing load time and API chatter.

### Why use effective status rules rather than stored `status = 'open'`?

The stored `status` column can lag reality. A meeting stored as `status = 'open'` may have its `voting_closes_at` in the past (auto-close job hasn't run yet). `get_effective_status` accounts for this. The SQL subquery replicates the same three-condition logic so the filter is consistent with what the meeting list endpoint and the auth endpoint report as "open".

### Why exclude `pending` meetings?

A `pending` meeting (stored `status = 'open'` or `'pending'` but with future `meeting_at`) is not yet open for voting. Showing its building in the dropdown would lead voters to a building where they see a meeting they cannot yet enter. Excluding it is the correct UX — the building will appear once the meeting becomes effectively open.

### No changes to `GET /api/buildings/{building_id}/general-meetings`

This endpoint (used after the voter selects a building) continues to return all meetings for that building, including closed ones. This is intentional: once a voter has navigated to a specific building URL (e.g. a direct link) they should be able to see and review past closed meetings.

---

## Data Flow (Happy Path)

1. Browser opens voter home page → React Query calls `GET /api/buildings`
2. Backend runs the filtered query: returns only non-archived buildings that have at least one meeting where `status != 'closed'` AND `voting_closes_at > now()` AND `meeting_at <= now()`
3. Frontend renders the building dropdown with the filtered list
4. Voter selects a building → `GET /api/buildings/{id}/general-meetings` returns all meetings for that building (unfiltered, as today)
5. Voter sees at least one open meeting, clicks "Enter Voting", proceeds to auth

---

## Affected Files

| File | Change type |
|---|---|
| `backend/app/routers/public.py` | Modify `list_buildings` query |
| `backend/tests/test_lot_owner_api.py` | Update `TestListBuildings` — two existing tests assert buildings without AGMs appear; these must be updated; add new test cases |
| `backend/tests/test_phase2_api.py` | Update `TestPublicListBuildings` — same two tests; add new test cases |
| `frontend/tests/msw/handlers.ts` | No change required (handler already returns a pre-filtered fixture; no new scenario needed at MSW level) |
| `frontend/src/pages/vote/__tests__/BuildingSelectPage.test.tsx` | No change required — tests mock the API response; no new behaviour to assert at the component level |

---

## E2E Test Scenarios

### Happy path

1. **Building with an open meeting is shown in dropdown**
   - Seed: one building, one meeting with `status = open`, `meeting_at` in the past, `voting_closes_at` in the future
   - Open voter home page
   - Assert: building appears in the dropdown

### Error / edge cases

2. **Building with only a closed meeting is hidden**
   - Seed: one building, one meeting with `status = closed`
   - Open voter home page
   - Assert: building does not appear in the dropdown

3. **Building with no meetings is hidden**
   - Seed: one building, no meetings
   - Open voter home page
   - Assert: building does not appear in the dropdown

4. **Building with both an open and a closed meeting is shown**
   - Seed: one building with two meetings — one `closed`, one effectively `open`
   - Open voter home page
   - Assert: building appears in the dropdown (the open meeting is sufficient)

5. **Building with only a pending (future) meeting is hidden**
   - Seed: one building, one meeting with `meeting_at` in the future and `voting_closes_at` also in the future
   - Open voter home page
   - Assert: building does not appear in the dropdown

6. **Building with a time-expired open meeting (voting_closes_at in the past) is hidden**
   - Seed: one building, one meeting stored as `status = open` but with `voting_closes_at` in the past (effective status resolves to `closed` via timestamp)
   - Open voter home page
   - Assert: building does not appear in the dropdown

7. **Archived building is hidden even if it has an open meeting**
   - Seed: one building with `is_archived = true`, one open meeting
   - Assert: building does not appear in the dropdown (existing archived-building rule still applies)

### State-based scenario

8. **Dropdown updates when a meeting is manually closed by the admin**
   - Seed: building with an open meeting — voter sees building in dropdown
   - Admin closes the meeting
   - Voter refreshes the page
   - Assert: building no longer appears in the dropdown

---

## Vertical Slice Decomposition

This feature touches only the backend (`public.py` + two test files). The frontend requires no code changes — only MSW fixture adjustments are optionally useful for clarity but not mandatory. There is a single vertical slice:

**Slice 1 (backend-only):** Modify `list_buildings` query + update/extend backend tests. No frontend implementation work required. This slice is fully independently E2E-testable.
