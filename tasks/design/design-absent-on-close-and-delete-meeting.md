# Technical Design: Absent Tally on Close and Delete General Meeting

**Status:** Implemented

## Overview

This document covers two related features:

1. **Absent tally on close:** When a General Meeting is closed, lots that have not submitted a ballot are counted as "absent" in the results report. The absent count is computed at report-time from the difference between eligible lots and submitted lots — it is not stored as individual `Vote` rows.

2. **Delete meeting:** Admins can permanently delete a General Meeting that is in `pending` or `closed` status. Deleting an `open` meeting is blocked. The delete cascades through all meeting-related data.

**Schema migration required: NO** — all cascade relationships are already in place.

---

## Feature 1: Absent Tally on Close

### How absent is computed

The absent tally is **not** written to the database at close time. It is computed on-the-fly during the admin report query (`get_general_meeting_detail`) only when the meeting's effective status is `closed`.

The logic is in `backend/app/services/admin_service.py`, inside `get_general_meeting_detail`, for each motion:

```python
if get_effective_status(general_meeting) == GeneralMeetingStatus.closed:
    absent_ids: set[uuid.UUID] = eligible_lot_owner_ids - submitted_lot_owner_ids
else:
    absent_ids: set[uuid.UUID] = set()
```

- `eligible_lot_owner_ids`: all `lot_owner_id`s that have a `GeneralMeetingLotWeight` row for this meeting (snapshot taken at meeting creation time).
- `submitted_lot_owner_ids`: all `lot_owner_id`s that have at least one submitted `Vote` record for this meeting.
- `absent_ids`: the set difference — lots eligible to vote but with no submitted vote by close time.

While the meeting is still `open` or `pending`, `absent_ids` is always the empty set (absent does not accumulate during voting; it only becomes meaningful once the meeting closes).

### What happens during close

When `POST /api/admin/general-meetings/{id}/close` is called, `close_general_meeting` in the service:

1. Fetches the `GeneralMeeting`. Raises 404 if not found.
2. Raises 409 if `status` is already `closed`.
3. Sets `status = closed`, `closed_at = now`.
4. If `voting_closes_at` is in the future and `meeting_at` is in the past (meeting has started but voting window hasn't expired), sets `voting_closes_at = now`.
5. Deletes all `Vote` rows with `status = draft` for this meeting (cleans up in-progress votes that were never submitted).
6. Creates an `EmailDelivery` record with `status = pending` to trigger the results email.
7. Commits. Returns the updated `GeneralMeeting`.

No absent `Vote` rows are inserted. The email service is fired as a background task by the router after the service call returns.

### Absent in the tally response

The `MotionTally` shape returned by `GET /api/admin/general-meetings/{id}` includes:

```json
{
  "absent": {
    "voter_count": <int>,
    "entitlement_sum": <int>
  }
}
```

Where:
- `voter_count` = number of lots in `absent_ids`
- `entitlement_sum` = sum of `GeneralMeetingLotWeight.entitlement` for those lots

The `MotionVoterLists.absent` list contains `{ lot_number, entitlement }` entries for each absent lot.

### Close endpoint spec

| Property | Value |
|---|---|
| Method | `POST` |
| Path | `/api/admin/general-meetings/{general_meeting_id}/close` |
| Auth | `require_admin` |
| Request body | None |
| Success response | `200 OK` with `GeneralMeetingCloseOut` |
| 404 | Meeting not found |
| 409 | Meeting is already closed |
| 403 | Not admin |

**`GeneralMeetingCloseOut` shape:**
```json
{
  "id": "uuid",
  "status": "closed",
  "closed_at": "ISO 8601 datetime",
  "voting_closes_at": "ISO 8601 datetime"
}
```

---

## Feature 2: Delete General Meeting

### Cascade tree on `GeneralMeeting` delete

```
GeneralMeeting
├── Motion (cascade="all, delete-orphan")
│   └── Vote (ondelete="CASCADE")
├── GeneralMeetingLotWeight (cascade="all, delete-orphan")
├── Vote (cascade="all, delete-orphan")
├── BallotSubmission (cascade="all, delete-orphan")
├── SessionRecord (cascade="all, delete-orphan")
└── EmailDelivery (cascade="all, delete-orphan", uselist=False)
```

Both SQLAlchemy ORM `cascade="all, delete-orphan"` and PostgreSQL `ondelete="CASCADE"` FK constraints are present. A single `await db.delete(meeting)` cascades to all children.

### Service function: `delete_general_meeting`

```python
async def delete_general_meeting(general_meeting_id: uuid.UUID, db: AsyncSession) -> None:
    result = await db.execute(select(GeneralMeeting).where(GeneralMeeting.id == general_meeting_id))
    meeting = result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail="General Meeting not found")
    if meeting.status == GeneralMeetingStatus.open:
        raise HTTPException(status_code=409, detail="Cannot delete an open General Meeting")
    await db.delete(meeting)
    await db.commit()
```

**Guard:** The status check uses `meeting.status` (the stored enum value), not `get_effective_status`. This means a meeting with `status = pending` but `voting_closes_at` already in the past (i.e., time-based effective status = closed) would pass the guard and be deletable. In practice, meetings transition through pending → open → closed; a pending meeting with an expired `voting_closes_at` is an edge case that is allowed to be deleted.

**Allowed statuses for delete:** `pending` and `closed` (stored status). `open` is blocked with 409.

### Router endpoint: `DELETE /api/admin/general-meetings/{general_meeting_id}`

```python
@router.delete("/general-meetings/{general_meeting_id}", status_code=204)
async def delete_general_meeting_endpoint(
    general_meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: str = Depends(require_admin),
):
    await admin_service.delete_general_meeting(general_meeting_id, db)
```

Note: `require_admin` is also applied to the entire router, but an explicit `Depends(require_admin)` is repeated here (redundant but present in the implementation).

**Endpoint spec:**

| Property | Value |
|---|---|
| Method | `DELETE` |
| Path | `/api/admin/general-meetings/{general_meeting_id}` |
| Auth | `require_admin` |
| Request body | None |
| Success response | `204 No Content` |
| 404 | Meeting not found |
| 409 | Meeting is `open` — cannot delete an open meeting |
| 403 | Not admin |

---

## Frontend Changes

### 1. API function: `deleteGeneralMeeting` — `frontend/src/api/admin.ts`

```typescript
export async function deleteGeneralMeeting(meetingId: string): Promise<void> {
  const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
  const res = await fetch(`${BASE_URL}/api/admin/general-meetings/${meetingId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to delete meeting: ${res.status}`);
}
```

Uses raw `fetch` (not `apiFetch`) since there is no JSON response body.

### 2. Delete button — `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

**Visibility rule:** The "Delete Meeting" button is shown only when `meeting.status === "closed"` OR `meeting.status === "pending"`. It is not shown when `meeting.status === "open"`:

```tsx
{(meeting.status === "closed" || meeting.status === "pending") && (
  <button
    type="button"
    className="btn btn--danger"
    onClick={handleDelete}
    disabled={deleteMutation.isPending}
  >
    Delete Meeting
  </button>
)}
```

The button uses `btn--danger` styling to signal a destructive action.

**Confirmation dialog:**
```typescript
function handleDelete() {
  if (window.confirm("Delete this meeting? This cannot be undone.")) {
    deleteMutation.mutate();
  }
}
```

**Loading state:** `deleteMutation.isPending` disables the button while the request is in flight.

**Post-delete navigation:** On success, navigates to `/admin/general-meetings`:
```typescript
const deleteMutation = useMutation({
  mutationFn: () => deleteGeneralMeeting(meetingId!),
  onSuccess: () => {
    navigate("/admin/general-meetings");
  },
});
```

No error state is rendered for the delete mutation in the current implementation — failures surface as unhandled promise rejections from the mutation.

---

## Key Design Decisions

### Absent is computed at report-time, not stored

Recording absent votes as rows at close time would pollute the `Vote` table with synthetic records that did not originate from actual voter actions. The report-time computation is equivalent and adds no DB noise. It is also correct for the re-open scenario (absent lots are always `eligible - submitted` at the point of query, which is consistent whether closed manually or by time expiry).

### `voting_closes_at` is clamped to `now` on close

If an admin closes a meeting before its scheduled `voting_closes_at`, that timestamp is updated to `now` (but only when `meeting_at` is in the past — the meeting must have started). This ensures `get_effective_status` returns `closed` from timestamps alone even without the stored `status` column (defence in depth).

### Draft votes deleted on close

All `Vote` rows with `status = draft` are deleted when the meeting closes. Draft votes represent partially filled ballots that were never submitted. Deleting them keeps the tally clean: only submitted votes appear in the results.

### Email delivery triggered as background task

The `EmailDelivery` record is created synchronously inside `close_general_meeting`. The actual email dispatch is triggered by `asyncio.create_task(email_service.trigger_with_retry(meeting.id))` in the router, after the service returns. This means the HTTP response is returned before the email is sent. If the Lambda times out before the email is sent, `EmailDelivery.status` remains `pending` and the admin can use the "Resend Report" feature to retry.

### Open meetings cannot be deleted

Deleting an open meeting would remove active voter session records, ballot submissions, and live votes without giving voters a chance to complete their vote. The 409 guard on `open` meetings ensures admins must explicitly close the meeting first before deletion is possible.

### Stored status vs `get_effective_status` for the delete guard

The delete guard checks `meeting.status == GeneralMeetingStatus.open` (stored value), not `get_effective_status`. This is intentional: a meeting that is time-expired but still stored as `pending` (never started) can be deleted directly without needing to explicitly close it. A meeting stored as `open` must be closed first.

---

## Data Flow: Happy Path — Close Meeting

1. Admin clicks "Close Meeting" on `GeneralMeetingDetailPage`.
2. Confirmation dialog shown. Admin confirms.
3. Frontend calls `POST /api/admin/general-meetings/{id}/close`.
4. Service: sets `status = closed`, `closed_at = now`, clamps `voting_closes_at` if needed, deletes drafts, creates `EmailDelivery`.
5. Router receives the return value, fires `asyncio.create_task` for email delivery.
6. Returns `GeneralMeetingCloseOut` (200).
7. Frontend invalidates `["admin", "general-meetings", meetingId]`.
8. Detail page re-fetches. Status badge shows "closed". Delete Meeting button appears. Absent lots appear in tally.

## Data Flow: Happy Path — Delete Meeting

1. Admin is on `GeneralMeetingDetailPage` for a `closed` or `pending` meeting.
2. Admin clicks "Delete Meeting" (btn--danger).
3. `window.confirm("Delete this meeting? This cannot be undone.")` — admin confirms.
4. `deleteMutation.mutate()` called.
5. Frontend sends `DELETE /api/admin/general-meetings/{id}`.
6. Service: fetches meeting, checks `status != open`, calls `await db.delete(meeting)` and commits.
7. Returns 204.
8. `deleteMutation.onSuccess` navigates to `/admin/general-meetings`.
9. Meeting no longer appears in the list.

---

## Files Modified

| File | Change |
|---|---|
| `backend/app/services/admin_service.py` | `close_general_meeting` (absent computed at report-time in `get_general_meeting_detail`); `delete_general_meeting` |
| `backend/app/routers/admin.py` | `POST /api/admin/general-meetings/{id}/close`; `DELETE /api/admin/general-meetings/{id}` |
| `frontend/src/api/admin.ts` | `deleteGeneralMeeting` function |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Delete button (visible for closed/pending), confirmation dialog, `deleteMutation`, post-delete navigation |
