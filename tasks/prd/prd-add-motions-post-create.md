# PRD: Add Motions After Meeting Creation

## Introduction

Admins currently can only add motions during meeting creation (via CSV/Excel import). Once a General Meeting is created the motion list is fixed. This feature allows admins to add new individual motions to an existing meeting at any time while it is `pending` or `open`.

A new motion defaults to `is_visible = false` so it can be drafted and reviewed before being revealed to voters. The existing visibility toggle (already on the meeting detail page) is used to publish it when ready.

Adding a motion to a `closed` meeting is blocked — the meeting result is immutable once closed.

Admins may also edit or delete motions, but only while the motion is hidden (`is_visible = false`) and the meeting is not `closed`. This prevents modification of in-flight or completed vote data.

---

## Goals

- Admin can add a single motion (title, description, motion type) to an existing meeting from the meeting detail page.
- New motions default to `is_visible = false` so they can be prepared before being shown to voters.
- Adding a motion to a closed meeting is blocked with a 409 response.
- The UI shows the "Add Motion" form only for `pending` or `open` meetings.
- Admin can edit (title, description, motion_type) a hidden motion on a non-closed meeting.
- Admin can delete a hidden motion on a non-closed meeting.
- Edit and Delete are blocked (409) if the motion is visible or the meeting is closed.

---

## User Stories

### US-AM01: Backend endpoint to add a motion

**As an** admin,
**I want** a `POST /api/admin/general-meetings/{meeting_id}/motions` endpoint,
**so that** I can programmatically add a motion to an existing meeting.

**Acceptance criteria:**

- `POST /api/admin/general-meetings/{meeting_id}/motions` accepts:
  ```json
  {
    "title": "string (required, non-empty)",
    "description": "string | null (optional)",
    "motion_type": "general | special (default: general)"
  }
  ```
- `order_index` is auto-assigned as `MAX(existing order_index) + 1`. If the meeting has no motions, `order_index` starts at 0.
- `is_visible` is always set to `false` for newly added motions.
- Returns **201 Created** with the created motion in `MotionOut` shape.
- Returns **404** if the meeting does not exist.
- Returns **409** if the meeting is `closed` (effective status).
- Returns **403** if the caller is not an authenticated admin.
- Returns **422** if required fields are missing or invalid (e.g. empty title).

**Integration test coverage:**

- Happy path: add motion to open meeting — 201, correct `order_index`, `is_visible=false`.
- Happy path: add motion to pending meeting — 201.
- Add to closed meeting — 409.
- Meeting not found — 404.
- Missing `title` — 422.
- Empty `title` — 422.
- `motion_type` defaults to `general` when omitted.
- `order_index` correctly follows the existing maximum (e.g. existing motions at 0,1,2 → new one gets 3).
- `order_index` is 0 when the meeting currently has no motions.

---

### US-AM02: Admin UI — add motion form on meeting detail page

**As an** admin,
**I want** an "Add Motion" button on the meeting detail page,
**so that** I can add a new motion without leaving the page.

**Acceptance criteria:**

- An "Add Motion" button appears in the Motion Visibility section header for `pending` and `open` meetings.
- The button is **not shown** for `closed` meetings.
- Clicking "Add Motion" reveals an inline form (below the section heading, above the table) with:
  - **Title** text input (required, labelled "Title")
  - **Description** textarea (optional, labelled "Description")
  - **Motion Type** select with options "General" (value `general`) and "Special" (value `special`), defaulting to "General"
  - A "Save Motion" submit button
  - A "Cancel" button that hides the form without saving
- On submit:
  - Calls `POST /api/admin/general-meetings/{meetingId}/motions`
  - On success: closes the form, invalidates the meeting detail query (causing the table to refresh)
  - The new motion appears at the bottom of the motions table with the "Hidden" visibility label
- Error state: if the API call fails, an inline error message is shown beneath the form
- While the mutation is pending, the "Save Motion" button is disabled
- Typecheck (`tsc --noEmit`) and lint pass with no errors

---

### US-AM03: Backend endpoint to edit a motion

**As an** admin,
**I want** a `PATCH /api/admin/motions/{motion_id}` endpoint,
**so that** I can correct or update the title, description, or type of a drafted (hidden) motion before revealing it to voters.

**Acceptance criteria:**

- `PATCH /api/admin/motions/{motion_id}` accepts:
  ```json
  {
    "title": "string | null (optional)",
    "description": "string | null (optional)",
    "motion_type": "general | special | null (optional)"
  }
  ```
- At least one field must be provided; a body with all fields null/absent returns **422**.
- Only the fields present in the request body are updated; omitted fields are left unchanged.
- Returns **200** with the updated motion in `MotionVisibilityOut` shape (id, title, description, order_index, motion_type, is_visible).
- Returns **404** if the motion does not exist.
- Returns **409** if the motion is currently visible (`is_visible = true`) — detail: "Cannot edit a visible motion. Hide it first."
- Returns **409** if the meeting is `closed` (effective status) — detail: "Cannot edit a motion on a closed meeting."
- Returns **403** if the caller is not an authenticated admin.

**Integration test coverage:**

- Happy path: update all three fields — 200, all fields reflected in response.
- Partial update: update title only — other fields unchanged.
- Partial update: update description only.
- Partial update: update motion_type only.
- Motion not found — 404.
- Motion is visible — 409.
- Meeting is closed — 409.
- Not admin — 403.
- Body with no fields — 422.

---

### US-AM04: Backend endpoint to delete a motion

**As an** admin,
**I want** a `DELETE /api/admin/motions/{motion_id}` endpoint,
**so that** I can permanently remove a drafted (hidden) motion that is no longer needed.

**Acceptance criteria:**

- `DELETE /api/admin/motions/{motion_id}` deletes the motion row from the database.
- Returns **204 No Content** on success.
- Returns **404** if the motion does not exist.
- Returns **409** if the motion is currently visible (`is_visible = true`) — detail: "Cannot delete a visible motion. Hide it first."
- Returns **409** if the meeting is `closed` (effective status) — detail: "Cannot delete a motion on a closed meeting."
- Returns **403** if the caller is not an authenticated admin.
- After deletion, the remaining motions' `order_index` values are NOT renumbered — gaps are acceptable.

**Integration test coverage:**

- Happy path: delete a hidden motion — 204, motion row is gone from DB.
- Motion not found — 404.
- Motion is visible — 409.
- Meeting is closed — 409.
- Not admin — 403.

---

### US-AM05: Admin UI — edit and delete actions per motion

**As an** admin,
**I want** Edit and Delete buttons on each motion row in the meeting detail page,
**so that** I can correct or remove a drafted motion without navigating away.

**Acceptance criteria:**

- Each motion row in the Motion Visibility table shows an **Edit** button/icon and a **Delete** button/icon.
- Both buttons are **disabled** (visually greyed out, not clickable) when `motion.is_visible = true` OR the meeting status is `closed`.
- When disabled, the buttons carry a `title` tooltip: "Hide this motion first to edit or delete".
- Clicking **Edit** (on a hidden motion in a non-closed meeting):
  - Opens an inline edit form in or below the row, pre-filled with the motion's current `title`, `description`, and `motion_type`.
  - The form has a **Save** button and a **Cancel** button.
  - **Save** calls `PATCH /api/admin/motions/{motion_id}` with only the changed fields, then on success closes the form and invalidates the meeting detail query.
  - **Cancel** closes the form without saving.
  - If the API call fails, an inline error message is shown in the form.
  - The Save button is disabled while the mutation is pending.
- Clicking **Delete** (on a hidden motion in a non-closed meeting):
  - Shows a browser `confirm()` dialog: "Delete this motion? This cannot be undone."
  - On confirm: calls `DELETE /api/admin/motions/{motion_id}`, then on success invalidates the meeting detail query (the row disappears).
  - On cancel (confirm dismissed): no API call is made.
  - If the API call fails, an inline error message is shown near the row.
- Typecheck (`tsc --noEmit`) and lint pass with no errors.
- Verify correct rendering and interaction in browser using dev-browser skill.

---

## Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-1 | `POST /api/admin/general-meetings/{meeting_id}/motions` creates a motion with auto-assigned `order_index` (max+1, starting at 0) and `is_visible=false`. |
| FR-2 | Creating a motion on a meeting whose effective status is `closed` returns 409. |
| FR-3 | The Admin UI shows "Add Motion" form only for `pending` or `open` meetings. |
| FR-4 | New motions are hidden from voters by default; the admin must use the existing visibility toggle to reveal them. |
| FR-5 | The unique constraint `uq_motions_general_meeting_order` on `(general_meeting_id, order_index)` must never be violated — always use `MAX(order_index) + 1`. |
| FR-6 | `PATCH /api/admin/motions/{id}` updates title/description/motion_type; blocked (409) if motion is visible or meeting is closed. |
| FR-7 | `DELETE /api/admin/motions/{id}` deletes the motion; blocked (409) if motion is visible or meeting is closed. |
| FR-8 | Edit and Delete buttons in the admin UI are only active when `is_visible = false` and meeting is not `closed`. |

---

## Non-Goals

- No reordering of existing motions in this feature.
- No bulk/CSV import of additional motions after meeting creation (separate feature).
- No motion creation by voters.
- No renumbering of `order_index` after deletion — gaps in order_index are acceptable.
- No editing or deleting visible motions — admin must hide the motion first.
- No editing or deleting motions on a closed meeting.

---

## Technical Considerations

- **No schema migration required** — all required columns (`title`, `description`, `order_index`, `motion_type`, `is_visible`) already exist on the `motions` table.
- `order_index` auto-assignment uses `SELECT MAX(order_index) FROM motions WHERE general_meeting_id = ?`. If the result is `NULL` (no rows), start at 0.
- The `get_effective_status` helper (already used in `toggle_motion_visibility`) must be used to evaluate closed status, not the raw `status` column, because a meeting can be auto-closed by `voting_closes_at` passing.
- `PATCH` uses partial update semantics — only fields explicitly provided in the request body are written to the DB.

---

## Out of Scope

- Editing existing motion title, description, or type when the motion is visible.
- Deleting existing motions when the motion is visible or the meeting is closed.
- Bulk import of additional motions post-creation.
- Reordering motions.
