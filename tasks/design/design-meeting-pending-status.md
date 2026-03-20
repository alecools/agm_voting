# Technical Design: Meeting Pending Status

## Overview

Before this feature, all General Meetings were created with `status = 'open'`, meaning voters could enter voting before the scheduled meeting time. This feature introduces a `pending` status representing meetings that exist but have not yet started. It also wires up automatic status transitions (pending → open → closed) triggered on Lambda cold start, adds a manual "Start Meeting" action for admins, and updates the voter UI to show a disabled "Voting Not Yet Open" state for pending meetings.

---

## Database Changes

### Enum: `generalmeetingstatus`

A new value `'pending'` was added to the `generalmeetingstatus` PostgreSQL enum.

Migration file: `backend/alembic/versions/b4c5d6e7f8a9_add_pending_to_general_meeting_status.py`

The `ALTER TYPE ... ADD VALUE` DDL cannot run inside a transaction in PostgreSQL. The migration uses Alembic's `autocommit_block()` context manager:

```python
with op.get_context().autocommit_block():
    op.execute(sa.text(
        "ALTER TYPE generalmeetingstatus ADD VALUE IF NOT EXISTS 'pending'"
    ))
```

A backfill follows immediately (inside the regular transaction):

```sql
UPDATE general_meetings
SET status = 'pending'
WHERE meeting_at > NOW() AND status = 'open'
```

Downgrade reverts `pending` rows to `open`. PostgreSQL does not support removing enum values without recreating the type, so the `'pending'` label remains in the enum after downgrade (it is simply unused).

### No new columns

No new columns were added to `general_meetings`. The existing `meeting_at` (DateTime, tz-aware, non-null) and `voting_closes_at` (DateTime, tz-aware, non-null) fields provide all the timestamp data needed for status derivation.

A pre-existing CHECK constraint (`voting_closes_at > meeting_at`) remains in force.

---

## Backend Changes

### Status Model

`GeneralMeetingStatus` in `backend/app/models/general_meeting.py`:

```python
class GeneralMeetingStatus(str, enum.Enum):
    open = "open"
    closed = "closed"
    pending = "pending"
```

| Value | Meaning |
|-------|---------|
| `pending` | Meeting created but `meeting_at` is in the future; voting not yet open |
| `open` | Meeting has started; voting is live |
| `closed` | Voting has ended; ballots finalised and results emailed |

### Effective Status Derivation

The `get_effective_status(meeting)` function in `general_meeting.py` derives the runtime status from the stored value and timestamps:

```
if stored status == closed → return closed
if voting_closes_at is in the past → return closed
if meeting_at is in the future → return pending
return open
```

Stored `closed` always wins — a manually closed meeting cannot become open or pending due to timestamp drift. For `open` and `pending` stored values, timestamps are the authority. This means a meeting stored as `pending` whose `meeting_at` has now passed will report as `open` from `get_effective_status` before the auto-open job has run.

This function is called in every context where status is returned to a client: list endpoints, detail endpoint, auth verify, public meeting list, and voting submission guard.

### Status Transitions

```
[created with meeting_at > now]
       ↓
    pending
       ↓  (auto-open on cold start OR manual "Start Meeting")
      open
       ↓  (auto-close on cold start OR manual "Close Meeting")
    closed
```

There is no direct `pending → closed` path via a stored status change. However, if both `meeting_at` and `voting_closes_at` have passed before a cold start occurs, the auto-open job transitions `pending → open` (stored), then the auto-close job immediately transitions `open → closed` (stored), resulting in absent records being generated. The two jobs run in sequence within the same cold start.

### Auto-open and Auto-close on Cold Start

Implemented in `api/index.py` as an `asyncio.run(...)` call that executes once per Lambda cold start, after Alembic migrations complete. Both phases run inside a single async function `_auto_open_and_close_meetings()`.

**Phase 1 — Auto-open:**

```python
SELECT * FROM general_meetings
WHERE status = 'pending' AND meeting_at <= now()
```

For each result, sets `status = 'open'` and commits. The stored status is updated in the DB, not just derived.

**Phase 2 — Auto-close:**

```python
SELECT * FROM general_meetings
WHERE status = 'open' AND voting_closes_at < now()
```

For each result, calls `close_general_meeting(meeting.id, db)` — the same service function used by the manual close endpoint — which generates absent `BallotSubmission` records and creates an `EmailDelivery` record. Failures are caught per-meeting and logged as warnings; they do not block remaining closures or app startup.

Both phases are wrapped in a top-level `try/except` so any unexpected error is logged as a warning without preventing the Lambda from starting.

The entire block is guarded by `if _db_url:` and all lines are marked `# pragma: no cover` because the block requires a live database and is exercised by integration tests, not unit tests.

### Meeting Creation: Initial Status Assignment

`create_general_meeting` in `admin_service.py` sets the initial status based on `meeting_at`:

```python
initial_status = (
    GeneralMeetingStatus.pending
    if data.meeting_at > datetime.now(timezone.utc)
    else GeneralMeetingStatus.open
)
```

The conflict check before creation also guards against duplicate active meetings:

```python
GeneralMeeting.status.in_([GeneralMeetingStatus.open, GeneralMeetingStatus.pending])
```

### Manual Start Endpoint

`POST /api/admin/general-meetings/{id}/start`

Service function: `start_general_meeting(general_meeting_id, db)`

- Fetches the meeting; raises 404 if not found
- Calls `get_effective_status(meeting)` and raises 409 if not `pending`
- Sets `status = 'open'` and `meeting_at = datetime.now(timezone.utc)`
- Commits and refreshes

The `meeting_at` update means the frontend will display the actual start time rather than the originally scheduled time after a manual start.

Response schema `GeneralMeetingStartOut`:

```typescript
{ id: string; status: string; meeting_at: string; }
```

### Manual Close Update (voting_closes_at)

`close_general_meeting` in `admin_service.py` was extended to update `voting_closes_at` when closing early:

```python
if (
    general_meeting.voting_closes_at is not None
    and general_meeting.voting_closes_at > now
    and (meeting_at_aware is None or meeting_at_aware <= now)
):
    general_meeting.voting_closes_at = now
```

The condition `meeting_at_aware <= now` prevents violating the `CHECK(voting_closes_at > meeting_at)` constraint when closing a pending meeting that has not yet started (edge case: admin closes before the meeting begins). In that scenario, `voting_closes_at` is preserved.

### Voting Guard for Pending Meetings

Both `save_draft` and `submit_ballot` in `voting_service.py` check effective status before processing:

```python
if effective == GeneralMeetingStatus.pending:
    raise HTTPException(status_code=403, detail="Voting has not started yet for this General Meeting")
```

This applies to both `PUT /api/general-meeting/{id}/draft` and `POST /api/general-meeting/{id}/submit`.

### API Responses

All endpoints that return meeting status call `get_effective_status(meeting)` rather than returning the raw stored value:

| Endpoint | Behaviour |
|----------|-----------|
| `GET /api/admin/general-meetings` | Returns effective status in each list item |
| `GET /api/admin/general-meetings/{id}` | Returns effective status in detail |
| `GET /api/buildings/{id}/general-meetings` (public) | Returns effective status per meeting |
| `POST /api/auth/verify` | Returns `agm_status: "pending"` for not-yet-started meetings |
| `GET /api/general-meeting/{id}/summary` (public) | Returns effective status |

---

## Frontend Changes

### Admin UI

**`GeneralMeetingListPage.tsx`** — The status filter dropdown includes a "Pending" option alongside "Open" and "Closed". Filtering is done client-side against the `status` field returned by the API.

**`GeneralMeetingDetailPage.tsx`** — Conditional rendering based on `meeting.status`:

- `pending`: renders `<StartGeneralMeetingButton>` and "Delete Meeting" button
- `open`: renders `<CloseGeneralMeetingButton>` only
- `closed`: renders "Delete Meeting" button only

**`StartGeneralMeetingButton.tsx`** (`frontend/src/components/admin/StartGeneralMeetingButton.tsx`):

- Renders a "Start Meeting" button that opens a confirmation dialog
- On confirm, calls `POST /api/admin/general-meetings/{id}/start` via `startGeneralMeeting(id)` in `api/admin.ts`
- On success, calls `onSuccess()` which invalidates the detail query and refreshes the page data
- Shows inline error text inside the dialog if the request fails

**`StatusBadge`** component renders the string value of `status` directly; no code change was required for it to display "pending".

### Voter UI

**`GeneralMeetingListItem.tsx`** (`frontend/src/components/vote/GeneralMeetingListItem.tsx`):

The CTA area renders one of three states based on `meeting.status`:

```
open     → <button class="btn--primary">Enter Voting</button>
pending  → <button class="btn--secondary" disabled>Voting Not Yet Open</button>
closed   → <button class="btn--secondary">View My Submission</button>
```

The pending button is disabled — clicking it has no effect.

**`AuthPage.tsx`** — After a successful OTP verify, if `data.agm_status === "pending"`:

```typescript
navigate("/", { state: { pendingMessage: "This meeting has not started yet. Please check back later." } });
return;
```

The voter is redirected to `BuildingSelectPage` with a message passed via React Router location state.

**`BuildingSelectPage.tsx`** — Reads `location.state?.pendingMessage` and renders it in an `info-banner` div with `role="status"` and `data-testid="pending-message"` when present.

This means a voter who successfully authenticates for a pending meeting sees the informational message on the building selection page rather than entering the voting flow.

---

## Key Design Decisions

**Auto-transitions on cold start only, not a scheduled job.** The Lambda architecture does not support persistent background tasks. Cold start is the natural integration point for side effects that must happen once per deployment lifecycle event. The tradeoff is that a meeting whose `meeting_at` passes between cold starts will not auto-open until the next request triggers a new cold start. `get_effective_status` mitigates this for read paths — a client always sees the correct derived status even if the DB row still says `pending`.

**`get_effective_status` as the single source of truth for derived status.** Rather than storing a computed field or running a scheduled UPDATE, all status reads go through `get_effective_status`. This avoids clock skew issues between the DB server and application server for the closed derivation, and provides consistent status to all API consumers without requiring the auto-open/close jobs to have run.

**Stored status is still meaningful.** Despite derivation, the stored status is not ignored: `closed` always wins over timestamp derivation (a manually closed meeting cannot become open again), and the auto-open/close jobs update stored status so subsequent queries do not need to re-derive on every row.

**`meeting_at` updated on manual start.** When an admin manually starts a pending meeting before its scheduled time, `meeting_at` is set to `now()`. This preserves the semantics of `meeting_at` as "when voting actually opened" rather than "when it was scheduled to open". The frontend displays `meeting_at` as "Meeting" time, so this shows the actual start time post-manual-open.

**`voting_closes_at` only updated on early manual close.** The condition `meeting_at_aware <= now` in `close_general_meeting` prevents backdating `voting_closes_at` on meetings that were never started. This guards against violating the `CHECK(voting_closes_at > meeting_at)` constraint when a pending meeting is somehow closed directly (which is not a supported flow, but the guard makes the close function safe to call in any scenario).

---

## Data Flow

End-to-end lifecycle for a scheduled meeting:

```
1. Admin creates meeting with meeting_at = T+2h, voting_closes_at = T+3h
   → create_general_meeting sets status = 'pending' (meeting_at > now)
   → Row in DB: status='pending'

2. Voter visits building list before T+2h
   → GET /api/buildings/{id}/general-meetings
   → get_effective_status: meeting_at > now → returns 'pending'
   → GeneralMeetingListItem renders disabled "Voting Not Yet Open" button

3. Voter authenticates before T+2h (submits OTP)
   → POST /api/auth/verify returns agm_status='pending'
   → AuthPage navigates to "/" with pendingMessage
   → BuildingSelectPage shows "This meeting has not started yet..."

4. Lambda cold start occurs after T+2h (on next incoming request)
   → _auto_open_and_close_meetings runs
   → Phase 1: meeting_at <= now AND status='pending' → sets status='open', commits
   → Phase 2: no meetings with voting_closes_at < now AND status='open' yet

5. Voter authenticates after T+2h
   → POST /api/auth/verify returns agm_status='open'
   → AuthPage navigates to VotingPage

6. Admin manually closes meeting at T+2.5h (before voting_closes_at)
   → POST /api/admin/general-meetings/{id}/close
   → status='closed', closed_at=now, voting_closes_at=now (was in future)
   → Absent BallotSubmission records created, EmailDelivery record created
   → Email triggered via asyncio.create_task

   OR:

6b. Cold start occurs after T+3h (voting_closes_at passed)
    → Phase 2: voting_closes_at < now AND status='open' → calls close_general_meeting
    → Same absent records + EmailDelivery created
```

Edge case — both timestamps passed before any cold start:

```
Cold start after T+3h:
  Phase 1: meeting_at <= now AND status='pending' → sets status='open', commits
  Phase 2: voting_closes_at < now AND status='open' → calls close_general_meeting
  Result: meeting goes pending → open → closed in single cold start
  Absent records are generated correctly
```
