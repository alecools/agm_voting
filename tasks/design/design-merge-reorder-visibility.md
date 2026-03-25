# Design: Merge Motion Reorder Controls into Visibility Table

## Overview

Currently the admin AGM detail page has two separate tables for managing motions:

1. **MotionReorderPanel** (lines 442-448 of `GeneralMeetingDetailPage.tsx`) -- a standalone component with drag handle, `#`, Title, Type, and move buttons (top/up/down/bottom). Uses `@dnd-kit/core` + `@dnd-kit/sortable`.
2. **Motion Visibility table** (lines 450-614) -- an inline `<table>` with `#`, Motion (title + description), Type badge, Visibility toggle, and Actions (Edit/Delete).

These two tables show overlapping data and force the admin to look in two places. This change merges them into a single unified table.

## Database Changes

None. No schema or migration changes required.

## Backend Changes

None. All APIs remain unchanged.

## Frontend Changes

### Component: `MotionReorderPanel.tsx` -- DELETE

The entire file `frontend/src/components/admin/MotionReorderPanel.tsx` will be deleted. Its logic (DndContext, SortableContext, useSortable, drag handles, move buttons) will be absorbed into the visibility table section of `GeneralMeetingDetailPage.tsx` via a new extracted component.

### Component: `MotionManagementTable.tsx` -- NEW

Create `frontend/src/components/admin/MotionManagementTable.tsx` to replace both tables with a single unified component.

**Props:**

```typescript
interface MotionManagementTableProps {
  motions: MotionDetail[];
  meetingStatus: string;           // "open" | "pending" | "closed"
  onReorder: (newOrder: MotionDetail[]) => void;
  isReorderPending: boolean;
  reorderError: string | null;
  // Visibility
  pendingVisibilityMotionId: string | null;
  isBulkLoading: boolean;
  motionsWithVotes: Set<string>;
  visibilityErrors: Record<string, string>;
  onToggleVisibility: (motionId: string, isVisible: boolean) => void;
  // Actions
  onEdit: (motion: MotionDetail) => void;
  onDelete: (motionId: string) => void;
  deleteMotionErrors: Record<string, string>;
}
```

**Table columns (in order):**

| Column | Content | When shown |
|--------|---------|------------|
| Drag handle | `⠿` grip icon via `useSortable` | Only when `isEditable` (open/pending) AND motions.length > 1 |
| `#` | `motion.motion_number` or `motion.display_order` | Always |
| Motion | Title (bold) + description (muted, below) | Always |
| Type | `motion-type-badge` pill | Always |
| Visibility | Toggle switch (`motion-visibility-toggle`) | Always (disabled when closed or has votes) |
| Actions | Edit + Delete buttons | Only when not closed |

**Drag-and-drop wiring:**

- Wraps the table body in `DndContext` + `SortableContext` (same as current `MotionReorderPanel`)
- Each row is a `SortableRow` using `useSortable` hook
- Move buttons (top/up/down/bottom) are rendered in the drag handle cell as a compact button group below the grip icon, only when `isEditable`
- `arrayMove` from `@dnd-kit/sortable` for reordering

**Row styling:**

- Hidden motions (`!motion.is_visible`): apply `admin-table__cell--muted` on data cells (#, Motion, Type) but NOT on Visibility or Actions cells (so toggle and buttons remain at full opacity)
- This matches the existing pattern documented in `design-system.md` section 6

### Page: `GeneralMeetingDetailPage.tsx` -- MODIFY

Changes:
1. Remove `import MotionReorderPanel` (line 21)
2. Add `import MotionManagementTable` from new component
3. Remove the "Motions" `<h2>` + `<MotionReorderPanel>` block (lines 441-448)
4. Remove the "Motion Visibility" `<h2>` (line 450)
5. Replace the entire visibility table section (lines 451-615) with a single section:
   - Keep the "Motions" `<h2>` heading
   - Keep the "Add Motion" button and "Show All" / "Hide All" bulk buttons (lines 452-479) -- move them above the new table
   - Render `<MotionManagementTable>` passing all required props
6. The `optimisticMotions` / `reorderMutation` / `handleReorder` logic stays in the page (it manages the query cache)
7. The `displayMotions` variable (line 352) is passed as the `motions` prop to the new table
8. Remove the separate `visibilityMutation` motion list (`meeting.motions`) for row rendering -- use `displayMotions` consistently so reorder + visibility are in sync

### Test file: `MotionReorderPanel.test.tsx` -- DELETE

Delete `frontend/src/components/admin/__tests__/MotionReorderPanel.test.tsx`. All its scenarios will be covered by the new component's test file.

### Test file: `MotionManagementTable.test.tsx` -- NEW

Create `frontend/src/components/admin/__tests__/MotionManagementTable.test.tsx` covering:

- Renders all columns (drag handle, #, title+description, type badge, visibility toggle, edit/delete)
- Drag handles hidden when meeting is closed
- Drag handles hidden when only 1 motion
- Move buttons disabled at boundaries (first/last)
- Visibility toggle disabled when meeting is closed
- Visibility toggle disabled when motion has votes
- Visibility error displayed per-row
- Delete error displayed per-row
- Muted styling on hidden motions
- Edit/Delete buttons disabled when motion is visible
- Edit/Delete buttons hidden when meeting is closed

### Test file: `GeneralMeetingDetailPage.test.tsx` -- MODIFY

- Remove any assertions that reference the separate reorder panel heading or "Motion Visibility" heading
- Update assertions to work with the merged table
- Ensure coverage of the "Add Motion", "Show All", "Hide All" buttons which remain in the page

### E2E spec: `admin-general-meetings.spec.ts` -- MODIFY

Update any assertions that depend on the old two-table layout. The admin motion management journey now happens in a single table.

## Key Design Decisions

1. **Extract to a new component rather than inline everything** -- The merged table has significant complexity (dnd-kit wiring, visibility toggles, edit/delete actions, error states). Keeping it in a separate component keeps `GeneralMeetingDetailPage` manageable and makes the component independently testable.

2. **Move buttons stay in the drag handle column** -- Rather than adding a separate "Reorder" column, the move buttons (top/up/down/bottom) are placed below the drag grip icon in the same cell. This keeps the table compact. On closed meetings, the entire column is hidden.

3. **`displayMotions` used everywhere** -- Currently the reorder panel uses `displayMotions` (optimistic order) while the visibility table uses `meeting.motions` (server order). The merged table uses `displayMotions` consistently so there's no order mismatch between reorder and visibility.

4. **No new CSS classes needed** -- All styling uses existing design system classes: `admin-table`, `admin-table__drag-handle`, `admin-table__cell--muted`, `motion-type-badge`, `motion-visibility-toggle`, `btn` variants.

## Data Flow (Happy Path: Reorder + Toggle Visibility)

1. Admin opens AGM detail page -- `getGeneralMeetingDetail` fetches meeting with motions sorted by `display_order`
2. Admin drags motion 3 above motion 1 -- `useSortable` fires `onDragEnd`, `arrayMove` produces new order, `setOptimisticMotions` updates immediately, `reorderMutation` fires `PUT /api/admin/general-meetings/{id}/motions/reorder`
3. API responds with new display_order values -- query cache updated, optimistic state cleared
4. Admin toggles motion 2 to hidden -- `visibilityMutation` fires `PATCH /api/admin/motions/{id}/visibility`, toggle shows loading state
5. API responds -- query invalidated, motion now shows with muted styling in the table

## Schema Migration Note

**Schema migration needed: NO** -- this is a frontend-only refactor.

## Vertical Slice Decomposition

This is a single frontend slice. No backend changes, no schema changes. It cannot be parallelized further since the new component replaces both existing UI elements simultaneously.

## Files Changed Summary

| File | Action |
|------|--------|
| `frontend/src/components/admin/MotionManagementTable.tsx` | CREATE |
| `frontend/src/components/admin/__tests__/MotionManagementTable.test.tsx` | CREATE |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | MODIFY |
| `frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx` | MODIFY |
| `frontend/src/components/admin/MotionReorderPanel.tsx` | DELETE |
| `frontend/src/components/admin/__tests__/MotionReorderPanel.test.tsx` | DELETE |
| `frontend/e2e/admin/admin-general-meetings.spec.ts` | MODIFY (if it references the old layout) |

## E2E Test Scenarios

### Affected Journey: Admin (meeting management)

The existing `admin-general-meetings.spec.ts` E2E spec must be updated for any tests that interact with motions on the detail page. New/updated scenarios:

#### Happy Path
- **Reorder via move buttons in merged table**: Open a pending meeting with 3+ motions. Click "Move down" on the first motion. Verify the motion number column updates and the new order persists after page reload.
- **Toggle visibility in merged table**: Open a meeting. Toggle a motion to hidden. Verify the row appears muted. Toggle it back. Verify the row returns to normal.
- **Edit a hidden motion**: Hide a motion, click Edit, change the title, save. Verify the updated title appears in the table.
- **Delete a hidden motion**: Hide a motion, click Delete, confirm. Verify the row is removed.

#### Error/Edge Cases
- **Cannot hide a motion with votes**: Start a meeting, have a voter submit, then try to toggle the motion hidden. Verify error message appears inline.
- **Cannot reorder a closed meeting**: Close a meeting. Verify drag handles and move buttons are absent. Verify the visibility toggle is disabled.
- **Reorder + visibility in same session**: Reorder motions, then toggle one hidden, then reorder again. Verify all operations apply correctly without order conflicts.

#### State-Based Scenarios
- **Pending meeting**: Drag handles, move buttons, visibility toggles, edit/delete all available.
- **Open meeting**: Same as pending.
- **Closed meeting**: No drag handles, no move buttons, visibility toggles disabled, no edit/delete buttons. Table is read-only.
- **Single motion**: No drag handle, no move buttons (nothing to reorder). Visibility toggle still works.
