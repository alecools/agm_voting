# Design: Fix Motion Number Not Saved on Edit

## Overview

When an admin edits a hidden motion via the Edit Motion modal on the General Meeting detail page, changes to the **motion number** field are silently discarded. The title, description, and motion type are saved correctly, but `motion_number` is never sent to the API.

This is a pure bug fix — no new feature, no schema migration.

---

## Root Cause

The bug is a three-layer omission introduced when the `feat/custom-motion-number-and-reorder` feature added `motion_number` to the creation flow but did not wire it through the edit flow.

### Layer 1 — Backend Pydantic request schema

`MotionUpdateRequest` (backend/app/schemas/admin.py) does not include `motion_number`. FastAPI strips it from any incoming request body before it reaches the service.

### Layer 2 — Backend service update logic

`update_motion` (backend/app/services/admin_service.py) only updates title, description, and motion_type. No branch for motion_number.

### Layer 3 — Backend response schema

`MotionVisibilityOut` (backend/app/schemas/admin.py) does not include `motion_number` in the response.

### Layer 4 — Frontend API type

`UpdateMotionRequest` (frontend/src/api/admin.ts) does not include `motion_number`.

### Layer 5 — Frontend edit form state

`editForm` state in GeneralMeetingDetailPage.tsx does not include `motion_number`.

### Layer 6 — Frontend modal UI

The Edit Motion modal has no input for motion number.

### Layer 7 — Frontend form pre-fill on open

`setEditForm` does not read `motion.motion_number` when Edit is clicked.

### Layer 8 — Frontend submit handler

`handleEditSubmit` does not include `motion_number` in the mutation payload.

---

## No Schema Migration Required

The `motion_number` column already exists on the `motions` table.

---

## Additional UI Change: Move Reorder Buttons to Actions Column

The ordering buttons (⤒ ↑ ↓ ⤓) that were previously rendered in a separate Actions column inside the `MotionReorderPanel` component have been moved into the **Actions** column of the Motion Visibility table on the General Meeting detail page.

This consolidates all per-motion actions (Edit, Delete, and reorder) into a single column, reducing UI clutter and improving discoverability. The reorder buttons are only shown when the meeting is not closed, and use the `btn--admin` CSS class to match the admin table row style.

The `MotionReorderPanel` retains its drag-and-drop functionality (drag handle column), but its keyboard-based move button Actions column has been removed.
