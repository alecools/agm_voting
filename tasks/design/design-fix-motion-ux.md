# Design: Fix Motion UX Bugs

## Fix 1 — Visibility toggle not updating immediately

**Root cause:** `MotionManagementTable` maintains a `localOrder` state array to support optimistic drag-and-drop reordering. When `SortableRow` renders each row, it receives a `motion` object taken from `localOrder`, not directly from the `motions` prop. A sync check (lines 272–286) compares the incoming `motions` prop to `localOrder` and calls `setLocalOrder(motions)` when they differ — but calling `setState` during render queues a re-render rather than updating state in the same render pass. As a result, for one render cycle after the React Query cache is updated by `visibilityMutation`'s `onMutate`, the rows are still rendered with the stale `is_visible` value from `localOrder`, causing the toggle to visually lag behind the optimistic cache write.

**Fix:** Build a `Map` from the authoritative `motions` prop (keyed by `motion.id`) and look up each entry when rendering rows. `localOrder` still controls row ordering, but the `motion` object passed to each `SortableRow` is taken from the prop map (falling back to `localOrder` only if the ID is not found). This ensures volatile fields like `is_visible` always reflect the latest React Query cache state in the current render, with no extra render cycle required.

## Fix 2 — Reorder arrow buttons placement in Actions column

The four reorder arrow buttons (`⤒ ↑ ↓ ⤓`) were already placed inside the Actions `<td>` alongside Edit and Delete, ahead of those buttons. They use the same CSS classes (`btn btn--secondary btn--sm`) and carry `aria-label` attributes that include the motion title for full accessibility context (e.g. `aria-label="Move Motion 1 to top"`). No structural relocation was needed; the work for this fix was to add test coverage verifying that the reorder buttons render in the same table cell (`<td>`) as the Edit and Delete buttons, and to add an optimistic-update test for Fix 1.
