# Design: General Meeting Management

## Overview

General Meetings (AGMs) have a three-state lifecycle: `pending` → `open` → `closed`. Creation sets the initial status based on `meeting_at`. Meetings auto-open and auto-close on Lambda cold start. Admins can manually start (pending → open) or close (open → closed) a meeting. Closing creates absent `BallotSubmission` records for non-voters, deletes draft votes, and triggers the results email. Deletion is permitted for `pending` and `closed` meetings only. The admin list page has building and status filter dropdowns backed by URL search parameters. The voter-facing building list shows only buildings with at least one effectively-open meeting.

---

## Root Cause / Background

The `pending` status lets admins set up meetings in advance without voters being able to enter early. Cold-start auto-transitions eliminate the need for an always-on scheduler (incompatible with Lambda architecture). Meeting filters and the building-list API filter reduce noise in the admin UI and voter home page.

---

## Technical Design

### Database changes

**`general_meetings` table:**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `building_id` | UUID FK → `buildings.id` CASCADE | |
| `title` | VARCHAR | NOT NULL |
| `meeting_at` | TIMESTAMPTZ | NOT NULL |
| `voting_closes_at` | TIMESTAMPTZ | NOT NULL; CHECK `voting_closes_at > meeting_at` |
| `status` | Enum(`pending`, `open`, `closed`) | NOT NULL |
| `closed_at` | TIMESTAMPTZ | nullable |
| `created_at` | TIMESTAMPTZ | |

`GeneralMeetingStatus` enum: `pending = "pending"`, `open = "open"`, `closed = "closed"`.

The `'pending'` enum value was added via `ALTER TYPE generalmeetingstatus ADD VALUE IF NOT EXISTS 'pending'` in a migration using `autocommit_block()`.

### Backend changes

#### Effective status derivation

`get_effective_status(meeting)` in `backend/app/models/general_meeting.py`:

```
stored status == closed → return closed
voting_closes_at in the past → return closed
meeting_at in the future → return pending
→ return open
```

All API endpoints that return meeting status call `get_effective_status` rather than the raw stored value.

#### Meeting creation

`create_general_meeting` sets initial status:

```python
initial_status = GeneralMeetingStatus.pending if meeting_at > now() else GeneralMeetingStatus.open
```

Snapshots `GeneralMeetingLotWeight` rows for every lot in the building (capturing `unit_entitlement_snapshot` and `financial_position_snapshot` at creation time). These snapshots are never updated by subsequent lot owner imports.

#### Auto-transitions on cold start

`_auto_open_and_close_meetings()` in `api/index.py` runs once per Lambda cold start (after Alembic migrations):

- Phase 1 (auto-open): `SELECT WHERE status='pending' AND meeting_at <= now()` → set `status='open'`
- Phase 2 (auto-close): `SELECT WHERE status='open' AND voting_closes_at < now()` → call `close_general_meeting()` for each

Failures per meeting are caught and logged as warnings; they do not block app startup.

#### Manual start (`POST /api/admin/general-meetings/{id}/start`)

- 409 if effective status is not `pending`
- Sets `status = 'open'` and `meeting_at = now()` (records actual start time)
- Returns `{ id, status, meeting_at }`

#### Meeting close (`POST /api/admin/general-meetings/{id}/close`)

1. 409 if already closed
2. Sets `status = 'closed'`, `closed_at = now()`
3. If `voting_closes_at` is in the future and `meeting_at` is in the past: clamps `voting_closes_at = now()` (preventing violation of the `CHECK` constraint on early close)
4. Deletes all `Vote` rows with `status = 'draft'` for this meeting
5. Sets `voting_closed_at = meeting.closed_at` on all motions where `voting_closed_at IS NULL`
6. Creates absent `BallotSubmission(is_absent=True)` for every `GeneralMeetingLotWeight` lot that has no `BallotSubmission(is_absent=False)`; `voter_email` on absent rows = comma-separated owner emails + proxy email (snapshot at close time)
7. Calls `compute_multi_choice_outcomes()` to store pass/fail/tie on `MotionOption` rows
8. Creates `EmailDelivery(status='pending')` record
9. Router fires `asyncio.create_task(email_service.trigger_with_retry(meeting.id))` after the response is returned

Returns `{ id, status, closed_at, voting_closes_at }`.

#### Meeting delete (`DELETE /api/admin/general-meetings/{id}`)

- 404 if not found
- 409 if stored `status == 'open'` (admins must close first)
- `await db.delete(meeting)` cascades to motions, votes, ballot submissions, session records, email delivery

#### Admin list endpoint enhancements

`GET /api/admin/general-meetings`:
- Optional `?name=` substring filter on `GeneralMeeting.title` (case-insensitive `LIKE`)
- Optional `?building_id=` UUID filter
- Default `limit=100`, max 1000

`GET /api/admin/buildings`:
- Optional `?name=` substring filter on `Building.name`
- Default `limit=100`, max 1000

`GET /api/admin/buildings/{building_id}`:
- New single-resource endpoint; 404 if not found

#### Voter building list filter

`GET /api/buildings` (public endpoint) returns only non-archived buildings that have at least one meeting where:

```sql
status != 'closed' AND voting_closes_at > now() AND meeting_at <= now()
```

This mirrors `get_effective_status` returning `'open'` in SQL. Buildings with only `pending`, `closed`, or time-expired meetings are excluded.

### Frontend changes

**`GeneralMeetingListPage.tsx`** (`frontend/src/pages/admin/GeneralMeetingListPage.tsx`):
- Building dropdown filter (all buildings from `listBuildings()`)
- Status dropdown filter: All / Open / Pending / Closed
- Filter state stored in URL search params (`?building=<uuid>&status=<str>`)
- Client-side filtering: `meetings.filter(m => !building || m.building_id === building).filter(m => !status || m.status === status)`
- Page resets to 1 when filter changes

**`GeneralMeetingDetailPage.tsx`** (`frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`):
- `pending`: shows `StartGeneralMeetingButton` + "Delete Meeting" button
- `open`: shows `CloseGeneralMeetingButton` only
- `closed`: shows "Delete Meeting" button + "Resend Summary Email" button
- `deleteMutation` navigates to `/admin/general-meetings` on success
- "Resend Summary Email" button calls `POST /api/admin/general-meetings/{id}/resend-report`; visible whenever `status === "closed"` (not only on failed delivery)

**`StartGeneralMeetingButton.tsx`** (`frontend/src/components/admin/StartGeneralMeetingButton.tsx`):
- Confirmation dialog → calls `POST /api/admin/general-meetings/{id}/start` → invalidates detail query

**`GeneralMeetingListItem.tsx`** (voter-facing):
- `open` → "Enter Voting" button (primary)
- `pending` → "Voting Not Yet Open" button (disabled)
- `closed` → "View My Submission" button

---

## Security Considerations

- All admin meeting management endpoints require `require_admin`
- `POST /api/auth/verify` returns `agm_status: "pending"` for not-yet-started meetings; the frontend routes away to the building selection page with an informational message
- Absent `BallotSubmission` records are created at close time, not earlier, so vote tallies are always consistent

---

## Files Changed

| File | Change |
|------|--------|
| `backend/app/models/general_meeting.py` | `GeneralMeetingStatus` enum, `get_effective_status()` |
| `backend/app/services/admin_service.py` | `create_general_meeting`, `close_general_meeting`, `delete_general_meeting`, `start_general_meeting`, `list_general_meetings` (name + building_id filter), `list_buildings` (name filter) |
| `backend/app/routers/admin.py` | All meeting CRUD + start/close/delete endpoints; building single-resource endpoint; name/building_id filter params |
| `backend/app/routers/public.py` | `list_buildings` with EXISTS subquery filter |
| `api/index.py` | `_auto_open_and_close_meetings()` on cold start |
| `frontend/src/pages/admin/GeneralMeetingListPage.tsx` | Building + status filter dropdowns, URL params |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Start/close/delete buttons, resend email button |
| `frontend/src/components/vote/GeneralMeetingListItem.tsx` | Pending button state |
| `frontend/src/pages/vote/AuthPage.tsx` | Redirect to home with `pendingMessage` when `agm_status === "pending"` |
| `frontend/e2e/workflows/helpers.ts` | `createOpenMeeting`/`createPendingMeeting` use `?building_id=` cleanup query; `seedBuilding` uses `?name=` |

---

## Schema Migration Required

Yes — `ADD VALUE 'pending'` to `generalmeetingstatus` enum (with `autocommit_block()`); backfill existing future-dated meetings to `pending`.
