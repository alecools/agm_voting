# PRD: Motions

## Introduction

This document covers motion management for the AGM Voting App: CRUD operations on motions, display ordering, visibility toggles, motion types (General/Special), multi-choice motions, Excel import, and motion numbers.

---

## Goals

- Admins can add motions during meeting creation via manual entry or Excel import
- Admins can add, edit, and delete hidden motions on pending/open meetings post-creation
- Admins can control motion visibility per-motion while a meeting is open or pending
- Admins can reorder motions via drag-and-drop or keyboard-accessible move buttons
- Motion numbers (custom labels) are supported and stable across reorders
- Multi-choice motions support per-option For/Against/Abstain voting with an option limit

---

## User Stories

### US-013: Download CSV/Excel template for motion import

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to download a pre-formatted template so I know exactly how to structure my motions file before uploading.

**Acceptance Criteria:**

- [ ] A "Download template" link is visible on the meeting creation form
- [ ] Clicking the link downloads a file named `agm_motions_template.csv`
- [ ] The downloaded file contains one header row with columns: `Motion`, `Agenda Item`, `Motion Type`, `Description`
- [ ] The file contains three example data rows (two general, one special) to illustrate the expected format
- [ ] Typecheck/lint passes

---

### US-014: Upload CSV/Excel file to pre-fill motions on meeting creation form

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to upload a CSV or Excel file during meeting creation so that the motions list is pre-filled without manual entry.

**Acceptance Criteria:**

- [ ] The meeting creation form includes a file input labelled "Upload motions (CSV or Excel)"
- [ ] The file input accepts `.csv`, `.xlsx`, and `.xls` files
- [ ] After a valid file is selected, the motions list on the form is populated with rows parsed from the file
- [ ] Column mapping (all case-insensitive): `Motion` (required) → motion order; `Description` (required) → motion description when `Title`/`Agenda Item` column is present, otherwise used as motion title; `Title` or `Agenda Item` (optional) → motion title; `Motion Type` (optional) → `"general"` or `"special"` (default `"general"`)
- [ ] Files with only `Motion` + `Description` columns (old 2-column format) continue to work
- [ ] Motions are displayed in ascending `Motion` order
- [ ] The host can edit, reorder, add, or delete any pre-filled motion before saving
- [ ] No data is saved to the database until the host submits the form
- [ ] Typecheck/lint passes

---

### US-015: Display all Excel validation errors before import

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to see every error in my uploaded Excel file at once so I can fix them all before re-uploading.

**Acceptance Criteria:**

- [ ] If the uploaded file has any validation errors, the motions list is NOT pre-filled
- [ ] All errors are displayed in a visible error summary before the form fields
- [ ] Each error message identifies the row number and the specific problem
- [ ] The following conditions are treated as errors: missing `Motion` or `Description` column headers; empty `Description` on any row; missing or non-numeric `Motion` on any row; duplicate `Motion` values within the file
- [ ] Rows with no data (completely blank rows) are silently skipped
- [ ] The host can fix the file and re-upload without reloading the page
- [ ] Typecheck/lint passes

---

### US-V01: Add `motion_type` field to motions

**Status:** ✅ Implemented

**Description:** As a developer, I need motions to carry a type (General or Special) so the system can enforce eligibility rules.

**Acceptance Criteria:**

- [ ] Add `motion_type` column to `motions` table: `'general'` | `'special'`, NOT NULL, default `'general'`
- [ ] Migration generated and runs cleanly against dev and test DBs
- [ ] Existing motions are migrated with `motion_type = 'general'`
- [ ] `motion_type` is returned in all motion API responses
- [ ] Meeting creation form allows setting `motion_type` per motion (dropdown or toggle: General / Special)
- [ ] `motion_type` is included in the Excel motion import (column `Motion Type`); accepted values are `General` and `Special` (case-insensitive); missing or blank values default to `General`
- [ ] Typecheck/lint passes

---

### US-MN-01: Custom motion number

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to assign a custom display label (motion number) to each motion so that the voting page and reports show the official motion numbering from the meeting agenda.

**Acceptance Criteria:**

- [ ] The meeting creation form includes an optional "Motion number" text field for each motion; the field accepts any non-empty string up to 100 characters (e.g. "5", "5a", "Special Resolution 1")
- [ ] Leaving the motion number field blank is valid; if omitted at creation or add-motion time, `motion_number` is auto-assigned as `str(display_order)` (e.g. "1", "2", "3") so every motion always has a non-null number
- [ ] Whitespace-only input is treated as blank and stored as `NULL`
- [ ] On the voter-facing voting page, each motion card label is always rendered as `"MOTION {motion_number}"`
- [ ] On the public meeting summary page, each motion is listed with its `motion_number` as the label if set; otherwise `display_order` is used as fallback
- [ ] In the admin meeting detail page motion table, a "Motion #" column shows the custom motion number
- [ ] Motion numbers are unique per meeting — adding a motion with a duplicate non-null `motion_number` returns 409
- [ ] Motion number has no effect on display order
- [ ] `motion_number` is included in all motion-related API responses
- [ ] When editing a hidden motion via the Edit Motion modal, the admin can change or clear the motion number; `PATCH /api/admin/motions/{id}` accepts and persists `motion_number`
- [ ] `motion_number` is stable across reorders — `PUT /api/admin/general-meetings/{id}/motions/reorder` only updates `display_order`; it never modifies `motion_number`
- [ ] On the voter-facing voting page, motion position is determined by `display_order`, not array index
- [ ] The confirmation/SubmitDialog shows the same "MOTION {motion_number}" label alongside each motion title in the unanswered-motions list
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MN-02: Admin motion reordering

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to change the display order of motions so that voters see them in the intended agenda sequence, with drag-and-drop as the primary interaction and keyboard-accessible move buttons as fallback.

**Acceptance Criteria:**

- [ ] On the admin meeting detail page (open or pending meetings only), each row in the motion table has a drag handle that allows the admin to drag and drop it to a new position
- [ ] Each motion row has two order-control buttons in the Actions column: "Move to top" (⤒) and "Move to bottom" (⤓)
- [ ] Reordering takes effect immediately in the UI (optimistic update); the new order is persisted via `PUT /api/admin/general-meetings/{id}/motions/reorder` with the complete ordered list of motion IDs
- [ ] If the reorder API call fails, the UI reverts to the pre-drag order and shows an error message
- [ ] Reordering is not available when the meeting is closed
- [ ] After a reorder, the voter-facing voting page shows motions in the new order
- [ ] Changing display order does NOT change any motion's `motion_number`
- [ ] A meeting with a single motion has no drag handle and no move buttons
- [ ] `PUT /api/admin/general-meetings/{id}/motions/reorder` returns 409 if the meeting is closed, 422 if the submitted list is incomplete or has duplicate positions, 404 if the meeting does not exist
- [ ] Drag-and-drop reordering works on touch devices (iOS Safari, Android Chrome) — a 250 ms press-and-hold activates the drag
- [ ] The drag handle touch target is at least 44×44 CSS pixels (meets WCAG 2.5.8 minimum)
- [ ] `touch-action: none` is applied to the drag handle element so the browser does not intercept the touch gesture as a scroll during an active drag
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MN-03: Unified motion management table

**Status:** ✅ Implemented

**Description:** As a meeting host, I want reorder controls and visibility toggles in a single table so I can manage motion ordering and visibility in one place.

**Acceptance Criteria:**

- [ ] The admin meeting detail page shows a single "Motions" table that combines: drag handle, motion number, title/description, type badge, visibility toggle, and action buttons (Edit/Delete, plus reorder buttons ⤒ ⤓)
- [ ] The separate "Motion Reorder" panel and "Motion Visibility" heading are removed
- [ ] Drag handles and move-to-top/bottom buttons appear in the Actions column when the meeting is open or pending; absent when the meeting is closed
- [ ] Visibility toggles behave identically to the previous standalone table: disabled when closed, disabled when motion has received votes, inline error on failure
- [ ] Hidden motions appear with muted styling on data cells but full opacity on the visibility toggle and action buttons
- [ ] Edit and Delete buttons remain disabled when a motion is visible (must hide first)
- [ ] "Add Motion", "Show All", and "Hide All" buttons appear above the table (not closed meetings)
- [ ] Deleting a motion shows a confirmation modal dialog (not a browser `confirm()` popup)
- [ ] Visibility toggle applies an optimistic UI update immediately on click; on error the toggle reverts
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AM01 (add-motions): Backend endpoint to add a motion

**Status:** ✅ Implemented

**Description:** As an admin, I want a `POST /api/admin/general-meetings/{meeting_id}/motions` endpoint so I can programmatically add a motion to an existing meeting.

**Acceptance Criteria:**

- [ ] `POST /api/admin/general-meetings/{meeting_id}/motions` accepts: `title` (required), `description` (optional), `motion_type` (default: `general`), `motion_number` (optional), `option_limit` and `options` when `motion_type = "multi_choice"`
- [ ] `display_order` is auto-assigned as `MAX(existing display_order) + 1`; starts at 1 if no motions exist
- [ ] `motion_number` is auto-assigned as `str(display_order)` if omitted or null
- [ ] `is_visible` is always set to `false` for newly added motions
- [ ] Returns 201 Created with the created motion
- [ ] Returns 404 if the meeting does not exist
- [ ] Returns 409 if the meeting is `closed` (effective status)
- [ ] Returns 403 if the caller is not an authenticated admin
- [ ] Returns 422 if required fields are missing or invalid

---

### US-AM02 (add-motions): Admin UI — add motion form on meeting detail page

**Status:** ✅ Implemented

**Description:** As an admin, I want an "Add Motion" button on the meeting detail page so I can add a new motion without leaving the page.

**Acceptance Criteria:**

- [ ] An "Add Motion" button appears in the Motions section header for `pending` and `open` meetings; not shown for `closed` meetings
- [ ] Clicking "Add Motion" reveals an inline form (or modal) with: Title (required), Description (optional), Motion Type select, and for "Multi-Choice": option limit + option list
- [ ] On submit: calls `POST /api/admin/general-meetings/{meetingId}/motions`; on success closes the form and invalidates the meeting detail query
- [ ] The new motion appears at the bottom of the motions table with the "Hidden" visibility label
- [ ] If the API call fails, an inline error message is shown
- [ ] Typecheck/lint passes

---

### US-AM03 (add-motions): Backend endpoint to edit a motion

**Status:** ✅ Implemented

**Description:** As an admin, I want a `PATCH /api/admin/motions/{motion_id}` endpoint so I can correct or update the title, description, or type of a drafted (hidden) motion before revealing it to voters.

**Acceptance Criteria:**

- [ ] `PATCH /api/admin/motions/{motion_id}` accepts: `title`, `description`, `motion_type`, `motion_number`, `options`, `option_limit` (all optional; partial update semantics)
- [ ] At least one field must be provided; a body with all fields null/absent returns 422
- [ ] Returns 200 with the updated motion
- [ ] Returns 404 if the motion does not exist
- [ ] Returns 409 if the motion is currently visible (`is_visible = true`)
- [ ] Returns 409 if the meeting is `closed` (effective status)
- [ ] Returns 403 if the caller is not an authenticated admin
- [ ] Changing `motion_type` away from `multi_choice` during edit deletes all options and clears `option_limit`

---

### US-AM04 (add-motions): Backend endpoint to delete a motion

**Status:** ✅ Implemented

**Description:** As an admin, I want a `DELETE /api/admin/motions/{motion_id}` endpoint so I can permanently remove a drafted (hidden) motion.

**Acceptance Criteria:**

- [ ] `DELETE /api/admin/motions/{motion_id}` deletes the motion row from the database
- [ ] Returns 204 No Content on success
- [ ] Returns 404 if the motion does not exist
- [ ] Returns 409 if the motion is currently visible (`is_visible = true`)
- [ ] Returns 409 if the meeting is `closed` (effective status)
- [ ] Returns 403 if the caller is not an authenticated admin
- [ ] After deletion, the remaining motions' `display_order` values are NOT renumbered — gaps are acceptable

---

### US-AM05 (add-motions): Admin UI — edit and delete actions per motion

**Status:** ✅ Implemented

**Description:** As an admin, I want Edit and Delete buttons on each motion row in the meeting detail page, so I can correct or remove a drafted motion.

**Acceptance Criteria:**

- [ ] Each motion row in the Motions table shows an **Edit** button/icon and a **Delete** button/icon
- [ ] Both buttons are **disabled** when `motion.is_visible = true` OR the meeting status is `closed`
- [ ] When disabled, the buttons carry a `title` tooltip: "Hide this motion first to edit or delete"
- [ ] Clicking **Edit** (on a hidden motion in a non-closed meeting) opens a modal pre-filled with the motion's current fields; Save calls `PATCH /api/admin/motions/{motion_id}`; Cancel closes the form without saving
- [ ] Clicking **Delete** shows a modal confirmation dialog (not a browser `confirm()` popup) with the motion title, "Delete" and "Cancel" buttons; on confirm calls `DELETE /api/admin/motions/{motion_id}`
- [ ] Typecheck/lint passes

---

### US-MV01: Add `is_visible` field to Motion model

**Status:** ✅ Implemented

**Description:** As a developer, I need to store a visibility flag on each motion so the backend can filter what voters see.

**Acceptance Criteria:**

- [x] Add `is_visible` boolean column to the `motions` table, default `true`
- [x] Alembic migration generated and runs cleanly against dev and test DBs
- [x] Existing motions default to `is_visible = true` (no behaviour change for existing meetings)
- [x] `MotionOut` Pydantic schema (voting.py) includes `is_visible: bool`
- [x] `MotionOut` Pydantic schema (admin.py) includes `is_visible: bool`
- [x] Typecheck/lint passes

---

### US-MV02: Backend endpoint to toggle motion visibility

**Status:** ✅ Implemented

**Description:** As a developer, I need an API endpoint so the admin UI can toggle a motion's visibility.

**Acceptance Criteria:**

- [x] `PATCH /api/admin/motions/{motion_id}/visibility` accepts `{ "is_visible": bool }` and updates the field
- [x] Returns 200 with the updated motion object on success
- [x] Returns 404 if the motion does not exist
- [x] Returns 409 if the meeting is `closed` (toggling is not allowed on closed meetings)
- [x] Returns 409 if attempting to set `is_visible=false` on a motion that has received votes
- [x] Returns 409 when attempting to hide a motion with `voting_closed_at IS NOT NULL`
- [x] Returns 403 if the caller is not an authenticated admin
- [x] Typecheck/lint passes

---

### US-MV03: Admin UI — visibility toggle on motion list

**Status:** ✅ Implemented

**Description:** As a building manager, I want to toggle the visibility of each motion from the meeting detail page so I can control which motions are live during the meeting.

**Acceptance Criteria:**

- [x] Each motion row in the admin meeting detail page shows a visibility toggle
- [x] The toggle reflects the current `is_visible` state
- [x] Clicking the toggle calls `PATCH /api/admin/motions/{motion_id}/visibility` and updates the UI immediately on success
- [x] Hidden motions are visually distinguished in the admin list (e.g. dimmed row, "Hidden" badge)
- [x] The toggle is disabled when the meeting is `closed`
- [x] A loading state is shown on the toggle while the request is in flight
- [x] Error state shown if the request fails
- [x] Typecheck/lint passes

---

### US-MV08: Bulk hide/show all motions

**Status:** ✅ Implemented

**Description:** As a building manager, I want to show all or hide all motions at once so I can quickly control visibility at the start or end of a voting session.

**Acceptance Criteria:**

- [ ] Two buttons appear above the motion table: "Show All" and "Hide All"
- [ ] "Show All" sets `is_visible = true` for all motions in the meeting
- [ ] "Hide All" sets `is_visible = false` for all motions in the meeting that have NOT received any votes (motions with votes are skipped silently)
- [ ] Both buttons are disabled when the meeting status is `closed`
- [ ] A loading state is shown on the active button while requests are in flight
- [ ] Typecheck/lint passes

---

### US-MC-01: Admin creates a multi-choice motion

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to create a motion where voters select from a list of custom options (e.g., candidates, proposals) so I can run elections or preference votes within the AGM ballot.

**Acceptance Criteria:**

- [ ] The motion type selector includes a "Multi-Choice" option
- [ ] When "Multi-Choice" is selected, the form shows: an "Option limit" number input (label: "Max selections per voter", min 1, required) and a dynamic list of option text inputs with add/remove buttons
- [ ] At least 2 options are required; attempting to save with fewer shows an inline error: "At least 2 options are required"
- [ ] Option limit must be between 1 and the number of options inclusive
- [ ] Each option text must be non-empty (max 200 characters)
- [ ] Options have an explicit display order; the form provides simple up/down buttons to reorder options within the modal
- [ ] Saved multi-choice motions appear in the motion management table with a "Multi-Choice (N options)" badge
- [ ] `POST /api/admin/general-meetings` and `POST /api/admin/general-meetings/{id}/motions` accept `option_limit` and `options` when `motion_type = "multi_choice"`; missing or invalid fields return 422
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MC-02: Admin edits a multi-choice motion

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to update the options and option limit of a hidden multi-choice motion so I can correct mistakes before making it visible.

**Acceptance Criteria:**

- [ ] The Edit Motion modal for a hidden multi-choice motion shows the current option list and option limit, fully editable
- [ ] Admin can add, remove, rename, and reorder options
- [ ] Saving a multi-choice motion with fewer than 2 options or an out-of-range option limit is blocked with inline errors
- [ ] `PATCH /api/admin/motions/{id}` accepts `options` (replaces all existing options atomically) and `option_limit`; returns 422 on invalid input
- [ ] A visible multi-choice motion cannot be edited (must be hidden first — existing rule unchanged)
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-V12: Show motion type indicator on admin results page

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to see a "General" or "Special" badge on each motion in the admin results/report view.

**Acceptance Criteria:**

- [ ] Each motion row in the admin results report shows a "General" or "Special" badge next to the motion title, using the same CSS classes as the voter voting page (`MotionCard`)
- [ ] `motion_type` is already returned in the admin meeting detail API response (`GET /api/admin/general-meetings/{id}`) — no backend changes required
- [ ] The badge is visible for both open and closed meetings
- [ ] Typecheck/lint passes

---

### US-AUIF-05: Voter view — multi-choice motions show correct motion type label

**Status:** ✅ Implemented

**Description:** As a voter, I want to see the correct motion resolution type ("General" or "Special") on multi-choice motions.

**Acceptance Criteria:**

- [ ] In the voter voting view, a multi-choice motion with `motion_type = "general"` shows a "General" type badge (neutral pill) and a separate "Multi-Choice" badge (blue pill)
- [ ] A multi-choice motion with `motion_type = "special"` shows a "Special" type badge (amber pill) and a separate "Multi-Choice" badge
- [ ] Non-multi-choice motions are unaffected
- [ ] Typecheck/lint passes

---

## Functional Requirements

- FR-11: AGM records and their motions are immutable after creation. No edits or deletions are permitted regardless of AGM status once the motion is visible and has received votes.
- FR-16: Each motion has a `motion_number` (VARCHAR). Auto-assigned as `str(display_order)` when omitted. Whitespace-only input is treated as blank and stored as `NULL`. `motion_number` is unique per meeting (partial unique index `WHERE motion_number IS NOT NULL`). On the voter-facing voting page, every motion card always renders `"MOTION {motion_number}"` as its label.
- FR-17: Motions have a `display_order` (INTEGER, 1-based, unique per meeting). The admin can reorder motions via `PUT /api/admin/general-meetings/{id}/motions/reorder`. Reordering is only permitted on open or pending meetings. Changing `display_order` never modifies `motion_number`.
- FR-18: A third motion type — `multi_choice` — is supported alongside `general` and `special`. A multi-choice motion has a list of options (`motion_options` table) and an `option_limit` (integer, 1 to N options). Each selected option receives the voter's full UOE (not split). Selecting zero options is recorded as `abstained`. In-arrear lots are recorded as `not_eligible` for multi-choice motions.
- FR-19: Multi-choice motion tally is computed per option: for each option, the `voter_count` is the number of lots that selected it and `entitlement_sum` is the sum of their snapshotted UOE. A lot may appear in multiple option tallies. The `yes` and `no` tally categories are not applicable to multi-choice motions (returned as zero). `abstained` and `absent` tallies continue to apply.
- Visibility: Hidden motions do not appear on the voter voting page. Server-side filtering ensures hidden motion titles are never sent to the browser for unvoted motions. Motions the voter has already voted on are always returned even if hidden (read-only).

---

## Non-Goals

- No reordering of motions in the Excel import
- No motion creation by voters
- No editing or deleting visible motions — admin must hide the motion first
- No editing or deleting motions on a closed meeting
- No bulk CSV import of additional motions after meeting creation
- No scheduling or time-based auto-reveal of motions
- Reopening a per-motion-closed motion is not supported (irreversible once closed)
