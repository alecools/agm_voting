# Design: Fix Motion Table Bugs

**Status:** Implemented

## Summary

Three bug fixes for the AGM voting app motion management table in `GeneralMeetingDetailPage`.

---

## Bug 1: Visibility toggle — optimistic UI update

### Problem

After clicking the visibility toggle, the checkbox stays in its old state until the API round-trip completes and `invalidateQueries` triggers a refetch. This creates a noticeable lag in the UI.

### Fix

Added `onMutate` to `visibilityMutation` in `GeneralMeetingDetailPage.tsx`:

- `onMutate`: cancel in-flight queries, snapshot current cache, apply an immediate optimistic update that flips `is_visible` for the targeted motion.
- `onError`: roll back to the previous snapshot if the API call fails.
- `onSuccess`: clear pending state and invalidate queries to confirm with server data.

This pattern mirrors the existing `reorderMutation` approach.

### Files changed

- `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

---

## Bug 2: Reorder buttons — move into the visibility table's Actions column

### Problem

Reorder buttons (move up/down/top/bottom) were only in the separate `MotionReorderPanel` component above the visibility table. The user had to scroll between two separate tables to reorder and manage visibility.

### Fix

Added four reorder buttons (⤒ ↑ ↓ ⤓) to the Actions column `<td>` in the main visibility table. The buttons:

- Are only rendered when `!isEditDeleteDisabled` (meeting not closed, motion not visible) **and** there is more than one motion.
- Use the same `btn btn--ghost` CSS class as the buttons in `MotionReorderPanel`.
- Call `handleReorder()` with an inline array manipulation (move to top, swap adjacent, move to bottom).
- Are disabled for the first motion (up/top) and last motion (down/bottom), and also when `reorderMutation.isPending`.

`MotionReorderPanel` is kept in place (drag-and-drop is still available there). The buttons in the panel are not removed because the panel also provides drag-and-drop reordering for keyboard/pointer users.

### Files changed

- `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

---

## Bug 3: Motion number — wire through the edit flow

### Problem

`motion_number` was added to the data model and create flow but never plumbed into the edit flow. It was absent from:

- `MotionUpdateRequest` Pydantic schema (backend)
- `update_motion` service (backend)
- `MotionVisibilityOut` response schema (backend)
- `UpdateMotionRequest` TypeScript interface (frontend)
- `MotionVisibilityOut` TypeScript interface (frontend)
- `editForm` state (frontend)
- Edit modal UI (frontend)
- Form pre-fill on Edit click (frontend)
- `handleEditSubmit` payload (frontend)

### Fix — Backend

**`backend/app/schemas/admin.py`**

- `MotionUpdateRequest`: added `motion_number: str | None = None`; updated `at_least_one_field` validator to count `motion_number`.
- `MotionVisibilityOut`: added `motion_number: str | None`.

**`backend/app/services/admin_service.py`** — `update_motion`:

- After existing field updates, strip and apply `motion_number` if provided (empty string → `None`).
- Include `"motion_number": motion.motion_number` in the returned dict.

### Fix — Frontend

**`frontend/src/api/admin.ts`**

- `UpdateMotionRequest`: added `motion_number?: string | null`.
- `MotionVisibilityOut`: added `motion_number: string | null`.

**`frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`**

- `editForm` state type: added `motion_number: string`.
- Edit button `onClick`: pre-fills `motion_number: motion.motion_number ?? ""`.
- Edit modal: added "Motion Number" input field (`#modal-edit-motion-number`), placed after Title.
- `handleEditSubmit`: includes `motion_number: editForm.motion_number` in the mutation payload (empty string clears to null on the backend).

### Files changed

- `backend/app/schemas/admin.py`
- `backend/app/services/admin_service.py`
- `frontend/src/api/admin.ts`
- `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

---

## Test changes

### Backend (`backend/tests/test_admin_api.py`)

Added to `TestMotionManagement`:

- `test_update_motion_all_fields_includes_motion_number` — PATCH with `motion_number: "42"` asserts response includes `motion_number == "42"`.
- `test_update_motion_partial_motion_number_only` — PATCH with only `motion_number: "SR-1"` returns 200 with `motion_number == "SR-1"`.
- `test_update_motion_motion_number_empty_string_clears` — PATCH with `motion_number: ""` returns `motion_number` as `null`.

### Frontend (`frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx`)

Updated:

- `modal pre-fills form fields with current motion values` — asserts `#modal-edit-motion-number` has value `"M-3"` (fixture updated to set `motion_number: "M-3"`).

Added:

- Edit motion modal: motion number edit and clear tests.
- "Visibility toggle optimistic update" describe block: tests immediate optimistic checkbox state change and error rollback.
- "Reorder buttons in visibility table actions column" describe block: tests rendering, disabled states, and that clicking calls reorder mutation.

### MSW handlers (`frontend/tests/msw/handlers.ts`)

- Updated PATCH motion handler to include `motion_number` in the response.
- Added `motion_number: "M-3"` to `ADMIN_MEETING_DETAIL_HIDDEN_MOTION`.
- Added `motion_number: null` to motions in `ADMIN_MEETING_DETAIL_MIXED_VISIBILITY` and `ADMIN_MEETING_DETAIL_ALL_HIDDEN`.
