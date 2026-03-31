# Design: Replace Browser confirm() with Modal Dialog for Motion Delete

**Status:** Implemented

## Overview

The "Delete" action on a hidden motion in the admin General Meeting detail page used the browser's native `window.confirm()` popup. This is inconsistent with the rest of the admin UI, which uses modal dialogs for destructive confirmations (e.g. delete building). Browser `confirm()` is also not stylable, is blocked in some environments (embedded iframes, certain browser extensions), and does not provide the motion title for context.

This change replaces the `confirm()` call with a React modal dialog that:
- Shows the motion title so the admin knows exactly what they are deleting
- Provides "Delete" (danger) and "Cancel" (secondary) buttons
- Follows the existing modal pattern used elsewhere in the admin UI

This is a frontend-only change — no backend or database changes required.

---

## Root Cause

In `GeneralMeetingDetailPage.tsx` (or `MotionManagementTable.tsx` after the merge-reorder-visibility refactor), the delete handler called:

```tsx
if (window.confirm("Delete this motion? This cannot be undone.")) {
  deleteMotionMutation.mutate(motionId);
}
```

`window.confirm()` blocks the browser's JS thread, is not customisable, does not show the motion name, and will not work correctly in headless test environments.

---

## Database Changes

None.

---

## Backend Changes

None. `DELETE /api/admin/motions/{id}` is unchanged.

---

## Frontend Changes

### New component: `DeleteMotionConfirmDialog`

A small modal dialog component (inline in `MotionManagementTable.tsx` or extracted to `frontend/src/components/admin/DeleteMotionConfirmDialog.tsx`):

**Props:**
```typescript
interface DeleteMotionConfirmDialogProps {
  motionTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}
```

**Render:** A centred modal overlay with:
- Heading: "Delete Motion"
- Body: "Are you sure you want to delete '{motionTitle}'? This cannot be undone."
- "Delete" button (`.btn.btn--danger`) — calls `onConfirm()`
- "Cancel" button (`.btn.btn--secondary`) — calls `onCancel()`

### `MotionManagementTable.tsx` (or `GeneralMeetingDetailPage.tsx`)

- Add state: `deleteConfirmMotion: MotionDetail | null` (null = dialog closed, non-null = motion pending confirmation).
- Replace `window.confirm(...)` in the delete button click handler with `setDeleteConfirmMotion(motion)`.
- Render `<DeleteMotionConfirmDialog>` when `deleteConfirmMotion !== null`.
- On confirm: call `deleteMotionMutation.mutate(deleteConfirmMotion.id)`, then `setDeleteConfirmMotion(null)`.
- On cancel: `setDeleteConfirmMotion(null)`.

---

## Key Design Decisions

- **Inline state, not global modal** — the delete confirmation is scoped to the motion management component; no global modal context is needed.
- **Shows motion title** — gives the admin a clear confirmation of exactly which motion will be deleted, reducing accidental deletion risk.
- **Consistent with existing patterns** — the delete building and close meeting confirmations in the admin UI all use modal dialogs; this brings motion delete in line.

---

## Schema Migration Note

**Schema migration needed: NO.**

---

## E2E Test Scenarios

### Affected journey: Admin (meeting management)

The existing admin motion management E2E spec must be updated:

#### Happy path
- **SC-DC-01**: Admin clicks Delete on a hidden motion. A modal dialog appears showing the motion title. Admin clicks "Delete". The motion is removed from the list.
- **SC-DC-02**: Admin clicks Delete on a hidden motion. The modal appears. Admin clicks "Cancel". The modal closes. The motion remains in the list and no API call is made.

#### Edge cases
- **SC-DC-03**: Verify that no browser `confirm()` dialog is triggered (Playwright does not register a `page.on('dialog')` event during the delete flow).
