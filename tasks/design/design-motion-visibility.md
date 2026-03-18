# Technical Design: Motion Visibility Toggle

## Overview

This feature adds an `is_visible` boolean flag to each motion, allowing admins to phase-reveal motions during a live meeting. Hidden motions are not sent to voters until revealed. Voters who have already submitted votes on some motions can re-enter the voting page after new motions are revealed and vote on the new ones without losing prior votes.

**Schema migration required: YES.** Any branch implementing this feature must have its own Neon DB branch and branch-scoped Vercel env vars before pushing (see CLAUDE.md: "Isolated DB for schema-migration branches").

---

## Database Changes

### New column: `motions.is_visible`

Add a boolean column to the `motions` table:

```
ALTER TABLE motions ADD COLUMN is_visible BOOLEAN NOT NULL DEFAULT TRUE;
```

| Property | Value |
|---|---|
| Column name | `is_visible` |
| Type | `BOOLEAN` |
| Nullable | `NOT NULL` |
| Default | `TRUE` (SQLAlchemy `default=True`, `server_default="true"`) |
| Impact on existing rows | All existing motions default to `is_visible = true` — no behaviour change |

### Alembic migration

A new migration file must be generated with `alembic revision --autogenerate -m "add_is_visible_to_motions"`. The `upgrade()` function adds the column with `server_default='true'`; the `downgrade()` drops it.

The migration chains off the current head: `a1b2c3d4e5f6` (slice_c_multi_email_per_lot_voting).

---

## Backend Changes

### 1. `Motion` model — `backend/app/models/motion.py`

Add one field to the `Motion` class:

```python
is_visible: Mapped[bool] = mapped_column(
    Boolean,
    nullable=False,
    default=True,
    server_default="true",
)
```

Import `Boolean` from `sqlalchemy`. No other changes to this file.

---

### 2. Voter-facing `MotionOut` schema — `backend/app/schemas/voting.py`

Add `is_visible: bool` to `MotionOut`. Also add `already_voted: bool` — this new field tells the frontend whether the voter has already submitted a vote for this motion (so the frontend can render it read-only).

```python
class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: Optional[str]
    order_index: int
    motion_type: MotionType
    is_visible: bool
    already_voted: bool = False  # True if the caller has a submitted Vote for this motion
```

`already_voted` defaults to `False` so existing code paths that construct `MotionOut` without it do not break.

---

### 3. Admin `MotionOut` and `MotionDetail` schemas — `backend/app/schemas/admin.py`

Add `is_visible: bool` to both:

```python
class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    order_index: int
    motion_type: MotionType
    is_visible: bool        # NEW

class MotionDetail(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    order_index: int
    motion_type: MotionType
    is_visible: bool        # NEW
    tally: MotionTally
    voter_lists: MotionVoterLists
```

Also add a new request schema for the toggle endpoint:

```python
class MotionVisibilityRequest(BaseModel):
    is_visible: bool
```

---

### 4. New endpoint: `PATCH /api/admin/motions/{motion_id}/visibility` — `backend/app/routers/admin.py`

**File:** `backend/app/routers/admin.py`

Add the import `MotionVisibilityRequest` from admin schemas. Add the route:

```python
@router.patch("/motions/{motion_id}/visibility", response_model=MotionDetail)
async def toggle_motion_visibility(
    motion_id: uuid.UUID,
    data: MotionVisibilityRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionDetail:
    result = await admin_service.toggle_motion_visibility(motion_id, data.is_visible, db)
    return MotionDetail(**result)
```

**Response shape:** `MotionDetail` (same as used in the meeting detail response — includes tally and voter_lists so the frontend can refresh in place).

**Status codes:**
- `200`: success
- `404`: motion not found
- `409`: meeting is closed OR (`is_visible=false` AND motion has submitted votes)
- `403`: not admin (handled by `require_admin` dependency on the router)

---

### 5. New service function: `toggle_motion_visibility` — `backend/app/services/admin_service.py`

Add a new async function:

```python
async def toggle_motion_visibility(
    motion_id: uuid.UUID,
    is_visible: bool,
    db: AsyncSession,
) -> dict:
```

Logic:
1. Fetch `Motion` by `motion_id`. Raise 404 if not found.
2. Fetch the associated `GeneralMeeting`. Check `get_effective_status(meeting)`. If `closed`, raise 409 "Cannot toggle visibility on a closed meeting".
3. If `is_visible=False`: count submitted `Vote` records where `Vote.motion_id == motion_id` and `Vote.status == VoteStatus.submitted`. If count > 0, raise 409 "Cannot hide a motion that has received votes".
4. Set `motion.is_visible = is_visible`. Flush.
5. Compute and return a `MotionDetail`-shaped dict (id, title, description, order_index, motion_type, **is_visible**, tally, voter_lists) using the same tally-building logic already in `get_general_meeting_detail`.

To avoid duplicating tally logic, extract the per-motion tally computation from `get_general_meeting_detail` into a private helper `_build_motion_detail_dict(motion, general_meeting_id, submitted_votes, submitted_lot_owner_ids, lot_entitlement, lot_info, db)` and call it from both `get_general_meeting_detail` and `toggle_motion_visibility`.

---

### 6. `GET /api/general-meeting/{id}/motions` — `backend/app/routers/voting.py`

**Current behaviour:** Returns all motions for the meeting ordered by `order_index`.

**New behaviour:** Returns:
- All motions where `is_visible = true`
- PLUS any motions where the voter has a submitted `Vote` record (`status = submitted`, keyed on `lot_owner_id` from the session's lots)

This ensures hidden motion titles are never leaked for unvoted motions, but the voter can always see their previously submitted votes.

The endpoint already requires a valid session via `get_session`. The session provides `voter_email`. Use `voter_email` to find submitted `Vote` records for this meeting and include their motion IDs in the query union.

**New `MotionOut` field `already_voted`:** Set to `True` for motions where the voter has a submitted vote, `False` for visible-but-unvoted motions.

Revised query strategy:
1. Find all `lot_owner_id`s for this voter via `LotOwnerEmail` + `LotProxy` joins (same logic as `auth/verify`).
2. Fetch all submitted `Vote.motion_id` values for `(general_meeting_id, lot_owner_id IN voter_lots)`.
3. Fetch all motions where `is_visible = true` OR `id IN voted_motion_ids`.
4. Build `MotionOut` for each, setting `already_voted = motion.id in voted_motion_ids`.

---

### 7. `POST /api/general-meeting/{id}/submit` — `backend/app/services/voting_service.py`

**Current behaviour:** `submit_ballot` fetches ALL motions for the meeting and iterates them, auto-abstaining any not answered.

**New behaviour:** Only iterate over motions where `is_visible = true` AND the voter has not already submitted a vote for that motion.

Change the motions query from:
```python
select(Motion).where(Motion.general_meeting_id == general_meeting_id).order_by(Motion.order_index)
```
to:
```python
select(Motion).where(
    Motion.general_meeting_id == general_meeting_id,
    Motion.is_visible == True,
).order_by(Motion.order_index)
```

Additionally, before inserting new votes, check for existing submitted `Vote` records for each `(lot_owner_id, motion_id)` pair. Skip (do not insert) for motions already voted on — this prevents a 409 from the unique constraint on `uq_votes_gm_motion_lot_owner`. The existing draft-deletion step already deletes drafts for the lots being submitted, so only submitted votes need this guard.

Also update the check for already-submitted `BallotSubmission` records: the current code raises 409 if ANY of the submitted lots already have a `BallotSubmission`. With re-entry voting, a lot can have a `BallotSubmission` but still need to submit votes on newly revealed motions. The new behaviour:
- If a lot already has a `BallotSubmission`, **do not create a new one** — reuse the existing one.
- Still check that the voter owns the lot.
- Only insert Vote records for visible motions that do not already have a submitted vote for this lot.

This means the 409 "already submitted" guard must be removed from the submit path. The duplicate vote guard (unique constraint) is the actual guard. If all visible motions for a lot already have submitted votes, the submit call is a no-op for that lot (returns success with the existing vote items).

---

### 8. `POST /api/auth/verify` — `backend/app/routers/auth.py`

**New field in response:** `unvoted_visible_count: int`

This is computed as: the count of motions where `is_visible = true` for which the voter (across ALL their lots) does NOT have a submitted `Vote` record.

For multi-lot voters: a motion counts as "unvoted" only if at least one of the voter's lots has no submitted vote for it.

**Implementation detail:**
1. After computing `all_lot_owner_ids` (existing logic), fetch all submitted `Vote.motion_id` values for the voter's lots in this meeting.
2. Fetch the count of visible motions for the meeting: `SELECT COUNT(*) FROM motions WHERE general_meeting_id = ? AND is_visible = true`.
3. Intersect: for each visible motion, check if ALL of the voter's lots have a submitted vote. If any lot is missing a vote for a visible motion, that motion contributes to `unvoted_visible_count`.
4. Return `unvoted_visible_count` in `AuthVerifyResponse`.

**Updated `AuthVerifyResponse` schema in `backend/app/schemas/auth.py`:**

```python
class AuthVerifyResponse(BaseModel):
    lots: list[LotInfo]
    voter_email: str
    agm_status: str
    building_name: str
    meeting_title: str
    unvoted_visible_count: int = 0   # NEW; defaults to 0 for backwards compat
```

---

### 9. `get_general_meeting_detail` — `backend/app/services/admin_service.py`

Admin always sees ALL motions (no filtering by `is_visible`). The existing query already fetches all motions; no change needed there.

Add `is_visible` to the motion detail dict in `motion_details.append(...)`:

```python
motion_details.append({
    "id": motion.id,
    "title": motion.title,
    "description": motion.description,
    "order_index": motion.order_index,
    "motion_type": motion.motion_type.value if hasattr(motion.motion_type, "value") else motion.motion_type,
    "is_visible": motion.is_visible,   # NEW
    "tally": { ... },
    "voter_lists": { ... },
})
```

---

### 10. `get_my_ballot` — `backend/app/services/voting_service.py`

**Current behaviour:** Fetches ALL motions for the meeting and builds `BallotVoteItem` for each, including ones the voter has not voted on (shows as abstained).

**New behaviour for US-MV06:** Only include motions where the voter has an actual submitted `Vote` record. Motions not voted on (hidden or visible) should NOT appear on the confirmation page.

Change the motions iteration: instead of iterating `motions` (all motions) and looking up votes, iterate `votes_by_lot` — i.e., only include motions for which an actual submitted vote row exists. This simplifies the logic and naturally excludes:
- Hidden motions with no vote
- Visible motions with no vote (voter hasn't submitted yet)

Keep the in-arrear `not_eligible` logic as-is for submitted `not_eligible` votes — these are real vote records that should appear.

The fallback for `NULL lot_owner_id` votes (legacy path) can be removed if the codebase has fully migrated to per-lot votes. If keeping it for safety, it only applies to motions not found via the main query.

---

## Frontend Changes

### 1. `src/api/voter.ts`

- Add `is_visible: boolean` and `already_voted: boolean` to `MotionOut` interface.
- Add `unvoted_visible_count: number` to `AuthVerifyResponse` interface (default 0 for backwards compat).

```typescript
export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
  is_visible: boolean;       // NEW
  already_voted: boolean;    // NEW
}

export interface AuthVerifyResponse {
  lots: LotInfo[];
  voter_email: string;
  agm_status: string;
  building_name: string;
  meeting_title: string;
  unvoted_visible_count: number;  // NEW
}
```

---

### 2. `src/api/admin.ts`

- Add `is_visible: boolean` to `MotionOut` and `MotionDetail` interfaces.
- Add `toggleMotionVisibility(motionId: string, isVisible: boolean): Promise<MotionDetail>` function.

```typescript
export interface MotionOut {
  // ... existing fields ...
  is_visible: boolean;   // NEW
}

export interface MotionDetail {
  // ... existing fields ...
  is_visible: boolean;   // NEW
}

export async function toggleMotionVisibility(
  motionId: string,
  isVisible: boolean
): Promise<MotionDetail> {
  return apiFetch<MotionDetail>(`/api/admin/motions/${motionId}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ is_visible: isVisible }),
  });
}
```

---

### 3. `GeneralMeetingDetailPage.tsx` — `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

Add a motions section above the `AGMReportView` that renders a visibility toggle per motion. The detail page already fetches `meeting.motions` via `getGeneralMeetingDetail`.

Changes:
- Import `toggleMotionVisibility` from admin API.
- Add a `useMutation` for `toggleMotionVisibility`. On success, call `queryClient.invalidateQueries` for the `["admin", "general-meetings", meetingId]` key to refresh the full detail (including updated `is_visible` and tally).
- Render a "Motions" card above `AGMReportView` listing each motion with:
  - Motion title + order index
  - "Hidden" badge when `is_visible === false`
  - A toggle button (eye icon or labelled button: "Show" / "Hide") that calls the mutation
  - Toggle disabled when `meeting.status === "closed"` or when the mutation is pending for that motion
  - Inline error message per motion if the toggle fails (e.g. "Cannot hide: motion has votes")

The `AGMReportView` continues to show all motions with full tally data — the new motions section is a separate control panel above it.

---

### 4. `AGMReportView.tsx` — `frontend/src/components/admin/AGMReportView.tsx`

- Add `is_visible: boolean` to the `MotionDetail` prop type (already imported from `admin.ts`).
- In the motion card header, render a "Hidden" badge alongside the motion type badge when `motion.is_visible === false`.

```tsx
{!motion.is_visible && (
  <span className="motion-type-badge motion-type-badge--hidden" aria-label="Motion is hidden from voters">
    Hidden
  </span>
)}
```

No other changes needed — tally data is always shown regardless of visibility.

---

### 5. `VotingPage.tsx` — `frontend/src/pages/vote/VotingPage.tsx`

The motions query now returns only motions the voter should see (visible + already voted). The new `already_voted` field on each motion drives read-only rendering.

Changes:
- Already-voted motions (`motion.already_voted === true`) should render as read-only in `MotionCard`. Pass a new `readOnly` prop to `MotionCard` when `already_voted` is true.
- In `MotionCard`: when `readOnly=true`, display the vote choice as a static label instead of interactive radio buttons, and do not call `onChoiceChange`.
- `answeredCount` and `unansweredMotions` should only count motions where `already_voted === false` (i.e., motions the voter still needs to answer). Already-voted motions do not need re-answering.
- The progress bar total should be `motions.filter(m => !m.already_voted).length` (only unvoted visible motions).
- If all returned motions have `already_voted === true` and there are no new visible unvoted motions, show a "No new motions" message and offer a "View Submission" button instead.

Empty state: if `motions` is an empty array after loading, show "No motions are available yet. Please check back shortly."

---

### 6. `AuthPage.tsx` — `frontend/src/pages/vote/AuthPage.tsx`

Update the routing logic in `verifyMutation.onSuccess` to use `unvoted_visible_count`:

```typescript
onSuccess: (data) => {
  // ... existing sessionStorage writes ...

  if (data.agm_status === "pending") {
    navigate("/", { state: { pendingMessage: "..." } });
    return;
  }
  if (data.agm_status === "closed") {
    navigate(`/vote/${meetingId}/confirmation`);
    return;
  }
  // Use unvoted_visible_count as the single source of truth for re-entry
  if (data.unvoted_visible_count > 0) {
    navigate(`/vote/${meetingId}/voting`);
  } else {
    navigate(`/vote/${meetingId}/confirmation`);
  }
}
```

This replaces the old `allSubmitted` check. The old check (`data.lots.every(l => l.already_submitted)`) was per-lot, which does not account for newly revealed motions. `unvoted_visible_count` is the server-authoritative answer.

---

### 7. `ConfirmationPage.tsx` — `frontend/src/pages/vote/ConfirmationPage.tsx`

The `my-ballot` endpoint will now return only motions with actual submitted votes (see backend change #10). The confirmation page already renders whatever `submitted_lots[].votes` contains — no logic change needed. The UI will naturally show only voted motions.

The "Vote for remaining lots" button (driven by `remaining_lot_owner_ids`) continues to work as-is.

---

## Key Design Decisions

### Server-side filtering (not client-side)
Hidden motion titles are never sent to the browser for unvoted motions. The `GET /motions` endpoint filters server-side. This prevents a determined voter from inspecting network traffic to see hidden motion titles before they are revealed.

### Exception: already-voted motions always returned
If a voter has submitted a vote for a motion that is subsequently hidden, that motion is still returned by the `/motions` endpoint (with `already_voted: true`). This allows the confirmation-during-voting UX where the voter can see what they've already done.

### `submit_ballot` iterates only visible motions
When a voter submits, only visible motions are considered. Hidden motions are not auto-abstained at submit time. This is the key enabler for phased voting: the voter submits what they can now, and when a new motion is revealed, they can submit again for just that motion.

### Re-entry via `BallotSubmission` reuse
The current model raises 409 if a lot already has a `BallotSubmission` and tries to submit again. With phased voting, we reuse the existing `BallotSubmission` — we do NOT create a new one. Uniqueness is enforced at the `Vote` level (`uq_votes_gm_motion_lot_owner`). The submission timestamp in `BallotSubmission` reflects the first submission; additional votes update the `Vote` table directly.

### `unvoted_visible_count` as re-entry signal
The frontend uses this single integer (from `auth/verify`) to decide whether to route to voting or confirmation. This avoids the frontend having to compute visibility logic locally. The server computes it with full knowledge of current visibility state.

### Admin cannot hide a motion with votes (decision 1A)
Once votes are cast on a motion, the admin cannot hide it. This prevents confusion about tally state (e.g., admin hides a controversial motion after most people voted Yes — the tally would look misleading if suddenly "hidden"). The 409 error message is: "Cannot hide a motion that has received votes."

### No hint to voters (decision 2A)
The voter sees what they see. No "X of Y motions" counter, no "more motions coming" message. Newly revealed motions appear silently on next refresh.

---

## Data Flow: Happy Path (Admin reveals hidden motion mid-meeting)

1. Admin creates meeting with 3 motions; motions 2 and 3 start `is_visible=false`.
2. Voter authenticates → `unvoted_visible_count=1` (only motion 1 visible, no votes yet) → routed to voting page.
3. Voting page fetches motions → receives motion 1 only (`is_visible=true`, `already_voted=false`).
4. Voter votes on motion 1 → submits → `BallotSubmission` created, `Vote` for motion 1 created.
5. Voter routed to confirmation → confirmation page calls `my-ballot` → sees motion 1 vote only.
6. Admin calls `PATCH /motions/{motion_2_id}/visibility { "is_visible": true }`.
7. Voter re-enters auth page → `auth/verify` → `unvoted_visible_count=1` (motion 2 visible, not yet voted by this lot) → routed to voting page.
8. Voting page fetches motions → receives: motion 1 (`already_voted=true`, rendered read-only) + motion 2 (`already_voted=false`, rendered interactive).
9. Voter votes on motion 2 → submits → `submit_ballot` finds existing `BallotSubmission` for this lot, reuses it; inserts new `Vote` for motion 2. No new `BallotSubmission` created.
10. Voter routed to confirmation → `my-ballot` → sees votes for motions 1 and 2.
11. Admin reveals motion 3 → voter repeats from step 7 for motion 3.

---

## E2E Test Scenarios (Playwright)

The following scenarios must be covered in the Playwright test suite. Existing voter/admin journey specs must be updated to reflect the new `already_voted` field and `unvoted_visible_count` re-entry logic.

1. **Admin toggle: visible → hidden (no votes)**
   - Create meeting with 2 motions (both visible). Toggle motion 2 to hidden. Verify admin UI shows "Hidden" badge on motion 2. Verify voter voting page shows only motion 1.

2. **Admin toggle: hidden → visible**
   - Create meeting with 2 motions (motion 2 hidden). Toggle motion 2 to visible. Verify voter voting page now shows both motions.

3. **Admin cannot hide motion with votes**
   - Create meeting, voter votes on motion 1. Admin attempts to hide motion 1. Verify 409 response and error shown in admin UI. Motion 1 remains visible.

4. **Admin cannot toggle on closed meeting**
   - Close a meeting. Admin attempts to toggle a motion. Verify toggle button is disabled in UI. Verify 409 response if called directly.

5. **Voter sees only visible motions (not hidden ones)**
   - Create meeting with motions 1 (visible) and 2 (hidden). Voter authenticates and goes to voting page. Verify only motion 1 is shown. Verify motion 2 title does NOT appear anywhere on the page.

6. **Previously-voted motion shown as read-only**
   - Voter submits vote on motion 1. Admin reveals motion 2. Voter re-enters. Voting page shows motion 1 as read-only (cannot change vote) and motion 2 as interactive. Verify motion 1's vote choice is displayed.

7. **Re-entry full flow: partial submit → reveal → re-enter → complete**
   - Meeting with motions 1 (visible) and 2 (hidden). Voter submits motion 1. Admin reveals motion 2. Voter re-enters (via auth page → routed to voting, not confirmation). Voter votes on motion 2 and submits. Confirmation page shows both motion 1 and motion 2 votes. Admin tally shows both motions with correct vote counts.

8. **Confirmation page shows all submitted votes regardless of visibility**
   - Voter submits votes on motions 1 and 2. Admin hides motion 2 (should fail — has votes — so skip the hide, or: voter submits, then admin cannot hide). Verify confirmation page shows both votes.
   - Alternative: Use a meeting where motion 2 was visible, voter voted, then admin tries to hide — gets 409. Confirmation still shows both. This tests that the guard works end-to-end.

9. **Admin report shows all motions with Hidden badge**
   - Create meeting with motion 1 (visible) and motion 2 (hidden). Voter submits. Admin detail page shows both motions. Motion 2 has "Hidden" badge. Tally is shown for both.

10. **No visible motions: empty state**
    - Create meeting with all motions hidden. Voter authenticates → `unvoted_visible_count=0`, no submissions → routed to voting page. Voting page shows "No motions are available yet" message.

---

## Files Modified Summary

### Backend
| File | Change |
|---|---|
| `backend/app/models/motion.py` | Add `is_visible: Mapped[bool]` column |
| `backend/app/schemas/voting.py` | Add `is_visible: bool` and `already_voted: bool` to `MotionOut` |
| `backend/app/schemas/auth.py` | Add `unvoted_visible_count: int` to `AuthVerifyResponse` |
| `backend/app/schemas/admin.py` | Add `is_visible: bool` to `MotionOut` and `MotionDetail`; add `MotionVisibilityRequest` |
| `backend/app/routers/admin.py` | Add `PATCH /motions/{motion_id}/visibility` endpoint |
| `backend/app/routers/voting.py` | Update `list_motions` to filter visible + already-voted; set `already_voted` field |
| `backend/app/routers/auth.py` | Compute and return `unvoted_visible_count` in `auth/verify` response |
| `backend/app/services/admin_service.py` | Add `toggle_motion_visibility`; add `is_visible` to `get_general_meeting_detail` motion dict |
| `backend/app/services/voting_service.py` | Update `submit_ballot` to only iterate visible motions and allow BallotSubmission reuse; update `get_my_ballot` to show only voted motions |
| `backend/alembic/versions/<new>.py` | Migration: add `is_visible` column to `motions` |

### Frontend
| File | Change |
|---|---|
| `frontend/src/api/voter.ts` | Add `is_visible`, `already_voted` to `MotionOut`; add `unvoted_visible_count` to `AuthVerifyResponse` |
| `frontend/src/api/admin.ts` | Add `is_visible` to `MotionOut` and `MotionDetail`; add `toggleMotionVisibility` function |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Add visibility toggle per motion; mutation + invalidation |
| `frontend/src/components/admin/AGMReportView.tsx` | Add "Hidden" badge for `is_visible === false` motions |
| `frontend/src/pages/vote/VotingPage.tsx` | Render already-voted motions as read-only; update progress bar; empty state |
| `frontend/src/pages/vote/AuthPage.tsx` | Use `unvoted_visible_count` for routing decision instead of `allSubmitted` |
| `frontend/src/pages/vote/ConfirmationPage.tsx` | No logic change needed; my-ballot response now only contains voted motions |
| `frontend/src/components/vote/MotionCard.tsx` | Add `readOnly` prop; render read-only mode when `already_voted` is true |
