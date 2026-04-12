# Design: Motion Management

## Overview

Motions belong to a `GeneralMeeting` and have a display order (`display_order`, 1-based integer), an optional custom label (`motion_number`), a type (`general`, `special`, or `multi_choice`), a visibility flag (`is_visible`), and an optional per-motion voting window (`voting_closed_at`). Admins can add, edit, delete, reorder, show/hide, and bulk-toggle motions. Motions can also be imported from CSV/Excel at AGM creation time. A public summary page shows the motion list for any meeting.

---

## Data Model

### `motions` table

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `general_meeting_id` | UUID FK → `general_meetings.id` CASCADE | |
| `title` | VARCHAR | NOT NULL |
| `description` | TEXT | nullable |
| `display_order` | INTEGER | NOT NULL; 1-based; unique per meeting via `uq_motions_meeting_display_order` |
| `motion_number` | VARCHAR | nullable; display label shown to voters; partial unique index per meeting (`WHERE motion_number IS NOT NULL`) |
| `motion_type` | Enum(`general`, `special`, `multi_choice`) | NOT NULL |
| `is_visible` | BOOLEAN | NOT NULL; DB default `true`; new motions added post-creation default to `false` |
| `voting_closed_at` | TIMESTAMPTZ | nullable; set by admin close or at meeting close |
| `option_limit` | INTEGER | nullable; required for `multi_choice` |

The `display_order` column was previously named `order_index` (0-based). Renamed in a migration that also shifted existing values to 1-based.

### `motion_options` table

Stores selectable options for `multi_choice` motions. See `design-multi-choice-motions.md` for full details.

---

## API Endpoints

### Create meeting with motions

`POST /api/admin/general-meetings` — `MotionCreate` objects in the request body include `display_order`, `motion_number`, `motion_type`, `option_limit`, `options`. The service normalises `display_order` to sequential 1-based integers sorted by the submitted value.

### Add motion to existing meeting

`POST /api/admin/general-meetings/{id}/motions`

- 409 if meeting is closed
- Auto-assigns `next_order_index = MAX(display_order) + 1` (or 1 if no motions exist)
- Creates motion with `is_visible = False` (hidden until admin reveals it)
- Returns `MotionOut` with 201

### Edit hidden motion

`PATCH /api/admin/motions/{id}`

- 409 if motion is visible (`is_visible = True`) — hide it first
- 409 if meeting is closed
- Partial update: `title`, `description`, `motion_type`, `option_limit`, `options` (all optional; at least one required)
- Returns `MotionVisibilityOut`

### Delete hidden motion

`DELETE /api/admin/motions/{id}`

- 409 if motion is visible
- 409 if meeting is closed
- Returns 204

### Toggle visibility

`PATCH /api/admin/motions/{id}/visibility`

Request: `{ is_visible: bool }`.

- 409 if hiding a motion that has received submitted votes ("Cannot hide a motion that has received votes")
- 409 if meeting is closed
- Returns `MotionDetail` (includes tally and voter lists)

### Bulk reorder

`PUT /api/admin/general-meetings/{id}/motions/reorder`

Request: `{ motions: [{ motion_id, display_order }] }` — must be the complete ordered list.

- 409 if meeting is closed
- 422 if list is empty, has duplicate `display_order` values, or does not contain all motion IDs for the meeting
- Assigns final normalised 1-based positions in one transaction (two-pass to avoid unique constraint violations mid-update)
- Returns `{ motions: [MotionOut] }` sorted by `display_order`

### Close individual motion

`POST /api/admin/motions/{id}/close`

- 409 if motion already closed or hidden
- 409 if meeting is closed
- Sets `motion.voting_closed_at = now()`
- Returns updated `MotionDetail`

### Public summary

`GET /api/general-meeting/{id}/summary` (no auth) — returns meeting metadata and the full motion list (all motions, regardless of `is_visible`) sorted by `display_order`. See `GeneralMeetingSummaryOut` schema.

---

## Frontend Components

### `MotionManagementTable.tsx` (`frontend/src/components/admin/MotionManagementTable.tsx`)

Unified table replacing the previous separate `MotionReorderPanel` and visibility table. Columns:

- Drag handle + move buttons (top/up/down/bottom) — only when meeting is not closed and `motions.length > 1`
- `#` — shows `motion_number` if set, else `display_order`
- Motion (title + description)
- Type badge (General / Special / Multi-Choice)
- Visibility toggle (disabled when meeting is closed or motion has votes)
- Actions (Edit / Delete — disabled when motion is visible or meeting is closed)

Drag-and-drop uses `@dnd-kit/core` + `@dnd-kit/sortable`. Move buttons provide keyboard/accessibility fallback. Optimistic update on drag; revert on API error.

Hidden motions display with `admin-table__cell--muted` styling on `#`, Motion, and Type cells (but not on Visibility or Actions cells).

### `GeneralMeetingDetailPage.tsx` (`frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`)

Above `AGMReportView` and `MotionManagementTable`:

- "Add Motion" button (hidden when `status === "closed"`)
- "Show All" button — calls `toggleMotionVisibility(m.id, true)` in parallel for all hidden motions via `Promise.all`
- "Hide All" button — calls `toggleMotionVisibility(m.id, false)` via `Promise.allSettled`; silently skips 409 "has votes" errors

`isBulkLoading` state disables all three bulk buttons and individual toggles while a bulk operation is in flight.

### `AGMReportView.tsx` (`frontend/src/components/admin/AGMReportView.tsx`)

- Motion label: `motion.motion_number?.trim() || String(motion.display_order)` followed by `. {motion.title}`
- "Hidden" badge on motions where `is_visible === false`
- CSV export uses `motion_number` if set

### `MotionCard.tsx` (`frontend/src/components/vote/MotionCard.tsx`)

Displays motion label as `motion_number` (if non-empty) or `"Motion {position}"` (1-based position prop passed from `VotingPage`). Already-voted motions render read-only.

### Motion import at AGM creation

**`MotionExcelUpload.tsx`** — file input accepting `.csv` and `.xlsx`. Client-side parsing via `frontend/src/utils/parseMotionsExcel.ts` (uses `exceljs` — SheetJS `xlsx` was removed due to CVEs). On valid parse, replaces the motion list in `CreateGeneralMeetingForm`. On error, shows `role="alert"` error list. A "Download template" link serves `/agm_motions_template.csv`.

Column mapping (case-insensitive): `Motion` → sort key, `Description` → title (2-col mode) or description (4-col mode), `Title`/`Agenda Item` → title (4-col mode), `Motion Type` → `motion_type`, `Motion Number` → `motion_number`.

### `GeneralMeetingSummaryPage.tsx` (`frontend/src/pages/GeneralMeetingSummaryPage.tsx`)

Public page at `/general-meeting/:meetingId/summary`. No auth required. Renders meeting title, building name, dates, status, and an `<ol>` of motions using `motion_number` or `display_order` as the label.

---

## Key Behaviours

- **`is_visible = False` on creation**: new motions added to existing meetings start hidden to prevent premature voter exposure.
- **Partial unique index on `motion_number`**: `WHERE motion_number IS NOT NULL` — multiple `NULL` values allowed but non-null duplicates within the same meeting are rejected with 409.
- **Motion number and display order are decoupled**: reordering does not change `motion_number`; setting `motion_number` does not affect `display_order`.
- **Votes on visible motions**: hiding a motion that has received submitted votes is blocked (409). This prevents confusing tallies.
- **Per-motion close**: `voting_closed_at` can be set on individual motions while the meeting remains open. Submission against a closed motion returns 422. `get_general_meeting_detail` uses `voting_closed_at` (or `meeting.closed_at`) as the absent-tally cutoff per motion.
- **Meeting close propagation**: when a meeting is closed, all motions with `voting_closed_at IS NULL` receive `voting_closed_at = meeting.closed_at`.
- **Normalised 1-based `display_order`**: every mutation (add, delete, reorder) leaves `display_order` as gap-free 1-based integers.

---

## Edge Cases

- Deleting a motion with `order_index` gaps: gaps in `display_order` are acceptable and do not cause errors.
- Hiding a motion with previously voted lots: blocked at the service layer (409), not just in the UI.
- `motion_number` whitespace-only: trimmed to empty string then stored as `NULL`.
- Excel import without a "Motion Number" column: motions get `motion_number = NULL` (positional fallback).
- Blank rows in import: silently skipped.

---

## Files

| File | Role |
|---|---|
| `backend/app/models/motion.py` | `Motion` model; `MotionType` enum; `voting_closed_at`, `display_order`, `motion_number`, `is_visible`, `option_limit` columns |
| `backend/app/schemas/admin.py` | `MotionCreate`, `MotionAddRequest`, `MotionUpdateRequest`, `MotionOut`, `MotionDetail`, `MotionVisibilityRequest`, `MotionVisibilityOut`, `MotionReorderRequest/Out` |
| `backend/app/schemas/voting.py` | Voter-facing `MotionOut` (includes `display_order`, `motion_number`, `is_visible`, `already_voted`) |
| `backend/app/schemas/agm.py` | `MotionSummaryOut` for public summary page |
| `backend/app/services/admin_service.py` | `add_motion_to_meeting`, `update_motion`, `delete_motion`, `toggle_motion_visibility`, `reorder_motions` |
| `backend/app/routers/admin.py` | All motion endpoints |
| `backend/app/routers/public.py` | `GET /api/general-meeting/{id}/summary` |
| `frontend/src/components/admin/MotionManagementTable.tsx` | Unified reorder + visibility table |
| `frontend/src/components/admin/MotionExcelUpload.tsx` | CSV/Excel motion import UI |
| `frontend/src/utils/parseMotionsExcel.ts` | Client-side parsing (exceljs + naive CSV branch) |
| `frontend/src/pages/GeneralMeetingSummaryPage.tsx` | Public summary page |
| `frontend/src/components/vote/MotionCard.tsx` | Voter-facing motion card |
| `frontend/public/agm_motions_template.csv` | Download template |

---

## Schema Migration Required

Yes — migrations added:
- `motions.is_visible` (BOOLEAN NOT NULL DEFAULT TRUE)
- `motions.display_order` (renamed from `order_index`; shifted to 1-based)
- `motions.motion_number` (VARCHAR nullable; partial unique index)
- `motions.voting_closed_at` (TIMESTAMPTZ nullable)
- `motions.option_limit` (INTEGER nullable)
- `motiontype` enum: added `multi_choice` value
