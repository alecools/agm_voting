# Design: Custom Motion Number and Drag-and-Drop Motion Reordering

## Overview

This feature adds two capabilities to the motion management system:

1. **Custom motion number** — each motion gets a `motion_number` string field (e.g. "5", "5a", "5b", "Special Resolution 1") that is displayed to voters as the motion label instead of an auto-incremented position counter. The field is a display-only annotation; it has no effect on display order.

2. **Display order control** — the admin can reorder motions via drag-and-drop (primary) and up/down/top/bottom buttons (fallback). The new order is persisted as an integer `display_order` field on the `motions` table. The existing `order_index` column is renamed to `display_order` and its role becomes explicit display ordering.

**Key invariant:** `motion_number` (the label shown to voters) and `display_order` (the rendered position) are fully decoupled. Editing one has zero effect on the other.

---

## Database Changes

### New and modified columns on the `motions` table

| Column | Change | Type | Nullable | Default | Notes |
|---|---|---|---|---|---|
| `display_order` | renamed from `order_index` | `INTEGER` | NO | — | Determines rendered sort order. Always normalised to 1, 2, 3, ... (1-based) after every mutation. |
| `motion_number` | new | `VARCHAR` | YES | `NULL` | Admin-supplied display label. NULL means the frontend falls back to the positional label. |

### Constraint changes

The existing unique constraint `uq_motions_general_meeting_order` on `(general_meeting_id, order_index)` must be **dropped** and recreated as `uq_motions_general_meeting_display_order` on `(general_meeting_id, display_order)`.

`motion_number` has a **unique constraint per meeting**: `uq_motions_general_meeting_motion_number` on `(general_meeting_id, motion_number)`. This constraint is implemented as a **partial unique index** (`WHERE motion_number IS NOT NULL`) so that multiple motions can have `motion_number = NULL` without violating uniqueness. The constraint is enforced at the DB level AND validated in the backend (409 if a duplicate non-null `motion_number` is provided).

**Fallback label:** when `motion_number` is null, the frontend displays `"Motion {display_order}"` (positional, 1-based, using the motion's `display_order` value).

### Migration strategy

One Alembic migration file handles all changes atomically:

1. Rename column `order_index` → `display_order` on `motions` (PostgreSQL: `ALTER TABLE motions RENAME COLUMN order_index TO display_order`).
2. Add column `motion_number VARCHAR NULL` to `motions`.
3. Drop the old unique constraint `uq_motions_general_meeting_order`.
4. Create new unique constraint `uq_motions_meeting_display_order` on `(general_meeting_id, display_order)`.
5. Data transformation: the existing integer values of `order_index` are 0-based sequential integers. After the rename they become `display_order`. The migration shifts them to 1-based by running `UPDATE motions SET display_order = display_order + 1`. This ensures display_order starts at 1 for all existing data, consistent with the new convention.

**Schema migration required: YES.** The implementing agent must create an isolated Neon DB branch before pushing, and set branch-scoped Vercel env vars per CLAUDE.md.

---

## Backend Changes

### Model: `Motion` (`backend/app/models/motion.py`)

- Rename mapped column `order_index` → `display_order`.
- Add `motion_number: Mapped[str | None] = mapped_column(String, nullable=True)`.
- Update `__table_args__`: drop old unique constraint name, add new `UniqueConstraint("general_meeting_id", "display_order", name="uq_motions_meeting_display_order")`.

### Schemas (`backend/app/schemas/admin.py`)

**`MotionCreate`** (used inside `GeneralMeetingCreate`):
- Rename `order_index: int` → `display_order: int`
- Add `motion_number: str | None = None`

**`MotionOut`**:
- Rename `order_index: int` → `display_order: int`
- Add `motion_number: str | None`

**`MotionDetail`** (used in `GeneralMeetingDetail`):
- Rename `order_index: int` → `display_order: int`
- Add `motion_number: str | None`

**New schema `MotionReorderItem`**:
```python
class MotionReorderItem(BaseModel):
    motion_id: uuid.UUID
    display_order: int
```

**New schema `MotionReorderRequest`**:
```python
class MotionReorderRequest(BaseModel):
    motions: list[MotionReorderItem]
```

**New schema `MotionReorderOut`**:
```python
class MotionReorderOut(BaseModel):
    motions: list[MotionOut]  # full updated list, sorted by display_order
```

### Schemas (`backend/app/schemas/voting.py`)

**`MotionOut`** (voter-facing):
- Rename `order_index: int` → `display_order: int`
- Add `motion_number: str | None`

**`BallotVoteItem`** (used in `MyBallotResponse` / confirmation screen):
- Rename `order_index: int` → `display_order: int`
- Add `motion_number: str | None`

### Schemas (`backend/app/schemas/agm.py`)

**`MotionSummaryOut`** (public summary page):
- Rename `order_index: int` → `display_order: int`
- Add `motion_number: str | None`

### API Endpoints

#### Modified endpoints

All existing endpoints that return `MotionOut`, `MotionDetail`, or `MotionSummaryOut` automatically include `motion_number` and `display_order` via the schema changes above. No URL path changes are needed for existing endpoints.

**`POST /api/admin/general-meetings`** — `create_general_meeting` service receives `MotionCreate.display_order` (was `order_index`). The service normalises submitted values to 1-based sequential integers sorted by the provided `display_order` value, then stores them. `motion_number` is persisted as-is (NULL if not provided).

**`GET /api/admin/general-meetings/{id}`** — returns `MotionDetail` objects now including `motion_number` and `display_order`.

**`GET /api/general-meeting/{id}/motions`** — returns `MotionOut` list now including `motion_number` and `display_order`. Sort order changes from `.order_by(Motion.order_index)` to `.order_by(Motion.display_order)`.

**`GET /api/general-meeting/{id}/summary`** — returns `MotionSummaryOut` now including `motion_number` and `display_order`. Sort order changes to `.order_by(Motion.display_order)`.

**`GET /api/general-meeting/{id}/my-ballot`** — `BallotVoteItem` now includes `motion_number` and uses `display_order` instead of `order_index`.

#### New endpoint: Bulk reorder

```
PUT /api/admin/general-meetings/{general_meeting_id}/motions/reorder
```

- **Auth**: requires admin session (`require_admin` dependency)
- **Request body**: `MotionReorderRequest`
  ```json
  {
    "motions": [
      { "motion_id": "<uuid>", "display_order": 1 },
      { "motion_id": "<uuid>", "display_order": 2 },
      { "motion_id": "<uuid>", "display_order": 3 }
    ]
  }
  ```
- **Response** `200 OK`: `MotionReorderOut` with full updated motion list sorted by `display_order`
- **Error responses**:
  - `404` if the meeting does not exist
  - `409` if the meeting is closed (status = closed or effective status = closed)
  - `422` if the list is empty
  - `422` if the submitted list does not contain exactly all motion IDs belonging to the meeting (partial reorder is rejected — the caller always sends the complete ordered list)
  - `422` if there are duplicate `display_order` values in the request

**Why a single bulk PUT and not individual PATCH calls?** A drag-and-drop interaction produces a complete new ordering in one atomic gesture. Sending N individual updates would require N round-trips and create intermediate states where the unique constraint on `display_order` fires mid-sequence. A single transaction replacing all positions avoids both problems.

### Service functions (`backend/app/services/admin_service.py`)

#### `create_general_meeting` (modified)

Replace `order_index=motion_data.order_index` with `display_order=motion_data.display_order`. Apply normalisation: sort incoming motions by their `display_order` value, then reassign 1, 2, 3, ... in order. Also persist `motion_number=motion_data.motion_number`. Update the returned dict to use `display_order` and `motion_number` keys.

#### New: `reorder_motions(general_meeting_id, request, db)`

1. Fetch the meeting; raise 404 if not found.
2. Raise 409 if the meeting is closed (check effective status).
3. Fetch all motions for the meeting.
4. Validate: `len(request.motions) == len(motions)`, all submitted `motion_id`s belong to this meeting, no duplicate `display_order` values in the request. Raise 422 on any violation.
5. Normalise positions: sort the request items by submitted `display_order`, then assign final positions 1, 2, 3, ... in that relative order.
6. Within a single transaction: update each `motion.display_order`. To avoid unique constraint violations during intermediate updates, apply positions in two passes — first assign large temporary values (e.g. `display_order + len(motions) + 1000`), commit the pass, then apply the final normalised values. Alternatively, temporarily defer the unique constraint within the transaction if the DB supports it.
7. Return `{"motions": [sorted motion dicts...]}`.

#### `get_general_meeting_detail` (modified)

Update the motions query sort: `.order_by(Motion.display_order)`. Update returned motion dicts to use `display_order` and include `motion_number`.

---

## Frontend Changes

### `frontend/src/api/admin.ts`

- Rename `order_index: number` → `display_order: number` in `MotionOut` and `MotionDetail` interfaces.
- Add `motion_number: string | null` to `MotionOut` and `MotionDetail`.
- Rename `order_index: number` → `display_order: number` in `MotionCreateRequest`.
- Add `motion_number?: string | null` to `MotionCreateRequest`.
- Add new interface `MotionReorderItem`:
  ```ts
  export interface MotionReorderItem {
    motion_id: string;
    display_order: number;
  }
  ```
- Add new interface `MotionReorderOut`:
  ```ts
  export interface MotionReorderOut {
    motions: MotionOut[];
  }
  ```
- Add new function:
  ```ts
  export async function reorderMotions(
    meetingId: string,
    motions: MotionReorderItem[]
  ): Promise<MotionReorderOut>
  ```

### `frontend/src/api/voter.ts`

- Rename `order_index: number` → `display_order: number` in `MotionOut`.
- Add `motion_number: string | null` to `MotionOut`.
- Rename `order_index: number` → `display_order: number` in `BallotVoteItem`.
- Add `motion_number: string | null` to `BallotVoteItem`.

### `frontend/src/api/public.ts`

- Rename `order_index: number` → `display_order: number` in `GeneralMeetingSummaryMotion`.
- Add `motion_number: string | null` to `GeneralMeetingSummaryMotion`.

### `frontend/src/components/admin/MotionEditor.tsx`

- Add `motion_number: string` to `MotionFormEntry` interface (default `""`).
- Add a "Motion number (optional)" text `<input>` to each motion entry in the form.
- Update `addMotion` to seed `motion_number: ""` on new entries.
- Update `updateMotion` to handle the `motion_number` field.

### `frontend/src/components/admin/CreateGeneralMeetingForm.tsx`

- Update the `motions.map(...)` in `handleSubmit`: include `motion_number: m.motion_number.trim() || null` and change `order_index: i` → `display_order: i + 1`.
- Initial state for a new motion entry now includes `motion_number: ""`.

### `frontend/src/utils/parseMotionsExcel.ts`

- Update `ParseSuccess` to return `MotionFormEntry[]` objects that now include `motion_number: ""` (empty for Excel-imported motions unless a "Motion Number" column is detected in the file).
- If a column header matching `/motion.?number/i` is detected in the uploaded file, read it into `motion_number`.

### `frontend/src/components/vote/MotionCard.tsx`

The displayed label currently shows `"Motion {motion.order_index}"` (0-based raw value on master). After this change:

- If `motion.motion_number` is a non-empty string after trimming, display it as-is: `{motion.motion_number}`.
- Otherwise, display `"Motion {position}"` where `position` is the 1-based index of the motion in the rendered array (passed as a new prop `position: number`).

The `MotionCard` receives a new prop `position: number` (the 1-based render index). The `VotingPage` passes `position={index + 1}` where `index` is the `.map` index over the sorted motions array.

### `frontend/src/components/vote/SubmitDialog.tsx`

On master, `SubmitDialog` takes `unansweredTitles: string[]`. The titles passed to it from `VotingPage` should now be the computed display label (motion_number if set, else positional label) plus the title — e.g. "5a — Approval of accounts". This means `VotingPage` must compute the label string before passing it.

### `frontend/src/pages/vote/VotingPage.tsx`

- Motions are already sorted server-side by `display_order`; no client-side sort needed.
- Pass `position={index + 1}` to each `MotionCard`.
- When building `unansweredTitles` for `SubmitDialog`, compute the label: `motion.motion_number?.trim() || \`Motion ${index + 1}\`` and combine with `motion.title`.

### `frontend/src/pages/GeneralMeetingSummaryPage.tsx`

- Update the motion list: the `<li key={...}>` should use a stable key (e.g. `display_order` or array index). The displayed label should be `motion.motion_number?.trim() || String(motion.display_order)` followed by `. {motion.title}`.
- Sort is server-side; no client-side sort needed.

### `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

On master this page shows only the results report — no motion management UI exists yet. This feature adds a **motion management section** above the report. The section is visible on all meeting statuses (open, pending, closed) but the reorder and edit controls are disabled/hidden on closed meetings.

**New motion management section:**

1. **Motion table** — columns: `#` (display_order), `Motion #` (motion_number, blank if null), `Title`, `Type`, and on open/pending meetings: `Actions` (reorder buttons).

2. **Drag-and-drop reordering**: wrap motion table rows in a drag-and-drop sortable list. Use `@dnd-kit/core` + `@dnd-kit/sortable` (see Library Choice below). On drag end, compute the new complete ordering and call `reorderMotions`. Apply an optimistic update immediately; revert on error.

3. **Move buttons** (fallback and accessibility): each row has four buttons — Move to top, Move up, Move down, Move to bottom. These buttons are disabled when at the boundary (first/last position). Clicking any button recomputes the full ordering and calls `reorderMotions`.

4. Buttons and drag handles are **only rendered when the meeting is open or pending**. On closed meetings the table is read-only.

### `frontend/src/components/admin/AGMReportView.tsx`

- Update the motion label from `{motion.order_index + 1}. {motion.title}` to use `motion.motion_number?.trim() || String(motion.display_order)` followed by `. {motion.title}`.
- Update the CSV export similarly: the label column in the export uses `motion_number` if set.

### Drag-and-drop library choice

**`@dnd-kit/core` + `@dnd-kit/sortable`**

Justification:
- Actively maintained (2024 releases), unlike `react-beautiful-dnd` (unmaintained, deprecated in favour of pragmatic-drag-and-drop, broken under React 18 StrictMode).
- Built for accessibility: keyboard navigation (Tab to item, arrow keys to move) works out of the box, which provides the same "move up/down" semantics as the fallback buttons — without extra code.
- Lightweight: ~10 KB gzipped for the sortable preset.
- Works with table rows via `useSortable` hook + a separate `DragOverlay` for the drag ghost.
- No global CSS pollution.

`react-beautiful-dnd` is explicitly excluded: deprecated, React 18 incompatible.

---

## Key Design Decisions

### 1. Rename `order_index` → `display_order` rather than add a parallel column

`order_index` has always semantically meant "the order in which this motion is displayed". Keeping the old name alongside a new `display_order` would create confusion. A rename migration is the clean approach. All callsites are updated atomically.

### 2. Normalised integers (not fractional indexing)

Fractional indexing (floats or string midpoints) allows gap-free insertion without rewriting all rows. Rejected because:
- The motion count per AGM is always small (single digits to low tens).
- Renormalising all motions in one transaction is trivially fast.
- Integer positions are human-readable in the DB.
- The unique integer constraint provides a clean data integrity guarantee.

After every mutation the service writes gap-free 1-based integers.

### 3. Partial unique index on `motion_number`

`motion_number` has a partial unique constraint per AGM (`WHERE motion_number IS NOT NULL`). This means:
- Two motions in the same meeting **cannot** share the same non-null `motion_number` value. The backend raises 409 if a duplicate is provided.
- Multiple motions **can** have `motion_number = NULL` (unset). The partial index excludes NULLs so they never collide.
- The SQLAlchemy `__table_args__` uses `Index(..., postgresql_where=...)` to define the partial index. A standard `UniqueConstraint` is **not** used here because PostgreSQL `UNIQUE CONSTRAINT` does not support partial predicates; a partial unique index achieves the same enforcement.

### 4. `motion_number` is nullable, not empty-string

NULL means "not set — fall back to positional label". An empty string is ambiguous (intentionally blank, or unset?). The frontend trims and sends `null` when the field is empty; the backend stores NULL.

### 5. Bulk PUT for reorder, not individual PATCH moves

A drag-and-drop interaction produces a complete new ordering in one gesture. A single `PUT` with the full ordered list:
- Is atomic (no intermediate constraint violations).
- Matches the mental model of "here is the desired final state".
- Eliminates N round-trips for an N-motion reorder.

### 6. 1-based `display_order`

Existing `order_index` values are 0-based. The migration shifts them to 1-based. This makes the stored value directly interpretable as a human-readable position, simplifying display logic.

### 7. Reorder only allowed on open/pending meetings

Consistent with the principle that closed meeting data is immutable audit history. The admin motion table is read-only after close.

---

## Data Flow: Happy Path — Admin Drag-and-Drop Reorder

1. Admin opens `GeneralMeetingDetailPage` for an open meeting.
2. The page loads motion list via `GET /api/admin/general-meetings/{id}`. Motions are returned sorted by `display_order`.
3. Admin drags motion row from position 3 to position 1 using the `@dnd-kit` drag handle.
4. `onDragEnd` fires with the new ordered array.
5. The component immediately applies an optimistic update to React Query cache (the list renders in the new order instantly).
6. `reorderMotions(meetingId, newOrderedList)` calls `PUT /api/admin/general-meetings/{id}/motions/reorder`.
7. Backend validates the list, normalises positions to 1-based, updates all rows in one transaction, returns the full sorted motion list.
8. React Query cache is updated from the response (confirming the optimistic update). If the request fails, `onError` reverts to the pre-drag cache snapshot.

---

## E2E Test Scenarios

### Persona journeys affected

This feature touches:
- **Admin journey**: meeting management — the motion table in `GeneralMeetingDetailPage` gains drag-and-drop, move buttons, and a motion number column. The AGM creation form gains a motion number field.
- **Voter journey**: voting page — `MotionCard` label display changes. The confirmation page `my-ballot` response includes `motion_number`.

The following existing E2E specs must be **updated** to reflect the new data shape (not just extended with new scenarios):
- `frontend/e2e/admin/admin-general-meetings.spec.ts` — motion table display, AGM creation assertions
- `frontend/e2e/workflows/voting-scenarios.spec.ts` — motion label assertions on voting page
- `frontend/e2e/workflows/admin-setup.spec.ts` — motion creation helpers

---

### Happy path scenarios

**SC-MN-01: Admin sets motion number at AGM creation**
1. Admin creates a new AGM. In the motion entry form, sets Motion Number to "Special Resolution 1".
2. AGM is created successfully.
3. Admin detail page shows "Special Resolution 1" in the Motion # column.
4. Voter opens the voting page; motion card shows "Special Resolution 1".

**SC-MN-02: Motion without a number falls back to positional label**
1. Admin creates an AGM with two motions; neither has a motion number set.
2. Voter sees "Motion 1" and "Motion 2" on the voting page.

**SC-MN-03: Motions from Excel import have blank motion number by default**
1. Admin uploads a motion Excel file (no "Motion Number" column).
2. Motions are imported. Motion number fields are empty.
3. Voter sees positional labels ("Motion 1", "Motion 2", ...).

**SC-MN-04: Motion number displayed on public summary page**
1. Seed: AGM with a motion having `motion_number = "5a"`.
2. Navigate to `/summary/{meetingId}`.
3. Summary page lists the motion as "5a — Title text".

**SC-RO-01: Admin reorders motions via drag-and-drop**
1. Seed: open AGM with 3 motions — "Alpha" (order 1), "Beta" (order 2), "Gamma" (order 3).
2. Admin drags "Gamma" to the top (position 1).
3. Table immediately shows: Gamma, Alpha, Beta.
4. Page reload confirms the order is persisted.
5. Voter opens the voting page and sees motions in the new order.

**SC-RO-02: Admin reorders via move buttons**
1. Seed: same 3-motion AGM.
2. Admin clicks "Move to top" on "Beta". Table shows: Beta, Alpha, Gamma.
3. Admin clicks "Move down" on "Beta". Table shows: Alpha, Beta, Gamma.
4. Admin clicks "Move up" on "Gamma". Table shows: Alpha, Gamma, Beta.
5. Admin clicks "Move to bottom" on "Alpha". Table shows: Gamma, Beta, Alpha.
6. Voter sees motions in the final order.

**SC-RO-03: Order and motion number are decoupled**
1. Seed: AGM with motions numbered "3" (display 1), "1" (display 2), "2" (display 3).
2. Admin reorders so "2" is first (new display order: 2→1, 3→2, 1→3).
3. Motion numbers remain "3", "1", "2" — unchanged by the reorder.
4. Voter sees three motion cards with labels "2", "3", "1" in that display order.

---

### Error and edge cases

**SC-ERR-01: Reorder on closed meeting — API returns 409**
1. Seed: closed AGM with 2 motions.
2. API call `PUT /api/admin/general-meetings/{id}/motions/reorder` returns 409.
3. The motion table on the detail page has no drag handles or move buttons (read-only).

**SC-ERR-02: Move buttons disabled at boundaries**
1. Open AGM with 3 motions. The first motion has "Move up" and "Move to top" buttons disabled. The last has "Move down" and "Move to bottom" buttons disabled.

**SC-ERR-03: Whitespace-only motion number treated as null**
1. Admin sets motion number to "   " (spaces only).
2. After save, the motion number is null. The voter sees the positional label.

**SC-ERR-04: Duplicate motion numbers are allowed**
1. Admin assigns "5a" to two motions at creation time.
2. Both motions are created successfully.
3. Both voter cards display "5a".

**SC-ERR-05: Single motion — no drag handles or move buttons**
1. AGM with exactly 1 motion. No drag handle and no move buttons are rendered (nothing to reorder).

**SC-ERR-06: Motion number survives reorder**
1. Seed: motions labelled "A" (pos 1), "B" (pos 2), "C" (pos 3).
2. Admin reorders to C, A, B.
3. After reorder: the three motions retain labels "C", "A", "B" respectively — the reorder did not change their `motion_number`.

---

### State-based scenarios

**SC-STATE-01: Motion management section is read-only on closed meetings**
1. Seed: closed AGM. Admin opens detail page.
2. Motion table is shown but no drag handles or move buttons are present.

**SC-STATE-02: Motion management section is interactive on open meetings**
1. Seed: open AGM. Admin opens detail page.
2. Motion table shows drag handles and all four move buttons per row (with boundaries disabled).

---

## Vertical Slice Decomposition

The feature decomposes naturally into two slices. They share one Alembic migration; slice B depends on slice A's schema being in place.

### Slice A: Custom motion number (schema + display)

**Scope:**
- DB migration: rename `order_index` → `display_order` (1-based shift), add `motion_number VARCHAR NULL`, update unique constraint.
- Backend: update `Motion` model, all schemas (`MotionCreate`, `MotionOut`, `MotionDetail`, `MotionSummaryOut`, `BallotVoteItem`), all service functions that read/write `order_index`, all router `ORDER BY` clauses.
- Frontend: update all TypeScript interfaces. Update `MotionCard` display label logic (use `motion_number` if set, else positional `position` prop). Update `MotionEditor` + `CreateGeneralMeetingForm` to include motion number text input. Update `GeneralMeetingDetailPage` to show Motion # column in the table. Update `AGMReportView`, `GeneralMeetingSummaryPage`, `VotingPage` (pass `position` prop).

**Independently testable:** Yes. After slice A, motion numbers can be set at creation and displayed everywhere. No drag-and-drop yet — the motion table shows the data, the reorder feature simply doesn't exist.

**E2E coverage:** SC-MN-01 through SC-MN-04, SC-ERR-03, SC-ERR-04, SC-ERR-05 (no reorder UI), SC-STATE-01 (read-only table), SC-STATE-02 (table without move buttons).

### Slice B: Motion reorder (new endpoint + drag-and-drop UI)

**Scope:**
- Backend: new `PUT /api/admin/general-meetings/{id}/motions/reorder` endpoint, `MotionReorderRequest`/`MotionReorderOut` schemas, `reorder_motions` service function.
- Frontend: install `@dnd-kit/core` + `@dnd-kit/sortable`. Add drag handles and move buttons to the motion table in `GeneralMeetingDetailPage`. Optimistic update + revert on error. Wire `reorderMotions` API client function.

**Depends on:** Slice A (the `display_order` column and updated interfaces must exist).

**Independently testable:** Yes. After slice B, both drag-and-drop and move buttons work. Motion numbers from slice A are already shown.

**E2E coverage:** SC-RO-01 through SC-RO-03, SC-ERR-01, SC-ERR-02, SC-ERR-06, SC-STATE-01 (updated: confirm no drag handles), SC-STATE-02 (updated: confirm drag handles present).

### Dependency graph

```
Slice A  (motion_number + display_order rename + label display)
    |
    v
Slice B  (reorder endpoint + drag-and-drop UI + move buttons)
```

Both slices must be implemented sequentially. Slice A can begin immediately on the `feat/custom-motion-number-and-reorder` branch.
