# Design: Touch/Mobile-Friendly Motion Drag-Drop Reordering

**Status:** Implemented

## Overview

The motion reordering drag-drop in `MotionManagementTable` works correctly on desktop using pointer events but is broken on touch devices (phones and tablets). Admins who access the meeting management page on a mobile browser cannot drag motions to reorder them because the `TouchSensor` from `@dnd-kit/core` is not registered in the sensor list. This design adds `TouchSensor` with an appropriate activation constraint, enlarges the drag handle touch target to meet WCAG 2.5.8 (44×44 px), and adds `touch-action: none` to the draggable rows so the browser does not intercept the gesture as a scroll.

No backend changes are needed. No database migration is required.

---

## Root Cause

`MotionManagementTable.tsx` lines 266–271 configure sensors as:

```ts
const sensors = useSensors(
  useSensor(PointerSensor),
  useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
);
```

`PointerSensor` handles mouse and stylus input. On mobile browsers, touch events do not always translate to pointer events in the same way — the browser treats a touch-start as a potential scroll gesture first. Without `TouchSensor`, `@dnd-kit` never receives the activation signal on touch devices and the drag does not start. Additionally, the drag handle `<span>` has no explicit width/height, so its rendered size is approximately 19×24 px — well below the 44×44 px minimum touch target required by WCAG 2.5.8.

---

## Affected Files

| File | Change type |
|---|---|
| `frontend/src/components/admin/MotionManagementTable.tsx` | Add `TouchSensor`, update drag handle inline styles |
| `frontend/src/styles/index.css` | Add `.admin-table__drag-handle` touch target rule |
| `frontend/tests/unit/MotionManagementTable.test.tsx` | Unit test coverage for touch sensor config |

---

## Frontend Changes

### 1. `frontend/src/components/admin/MotionManagementTable.tsx`

#### Import change (lines 2–9)

Add `TouchSensor` to the `@dnd-kit/core` import:

```ts
import {
  DndContext,
  PointerSensor,
  TouchSensor,          // ADD
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
```

#### Sensor configuration (lines 266–271)

Replace the existing `useSensors` block with:

```ts
const sensors = useSensors(
  useSensor(PointerSensor),
  useSensor(TouchSensor, {
    activationConstraint: {
      delay: 250,
      tolerance: 5,
    },
  }),
  useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
);
```

`delay: 250` — the browser waits 250 ms before treating the touch as a drag rather than a tap or scroll initiation. This matches the convention used by most touch-enabled sortable UIs and avoids accidental drags when the user is scrolling vertically through the table.

`tolerance: 5` — if the finger moves more than 5 px during the delay window, the drag is cancelled and the gesture is passed back to the browser as a scroll. This prevents the drag from stealing scroll on a long motions list.

#### Drag handle inline styles (lines 117–125)

The `<span>` that renders the `&#x2807;` (braille dots) handle currently has:

```tsx
style={{ cursor: isReorderPending ? "not-allowed" : "grab", fontSize: "1.2rem", userSelect: "none" }}
```

Replace with:

```tsx
style={{
  cursor: isReorderPending ? "not-allowed" : "grab",
  fontSize: "1.2rem",
  userSelect: "none",
  touchAction: "none",          // prevents browser scroll from intercepting the drag gesture
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 44,
  minHeight: 44,
}}
```

`touchAction: "none"` is the critical property. It signals to the browser that this element handles touch events itself and the browser should not claim the touch as a scroll. Without it, on iOS Safari in particular, the scroll wins and `@dnd-kit` never receives `touchmove` events.

`minWidth: 44` / `minHeight: 44` satisfies WCAG 2.5.8 (minimum touch target size of 44×44 CSS pixels) and makes the handle easier to hit with a thumb.

#### Draggable row — prevent scroll interference

The `<tr>` at line 113 receives the `setNodeRef` from `useSortable`. During an active drag, the entire row is the drag surface, which can conflict with native scroll on the table's overflow-x wrapper. Add `touchAction: "none"` to the row's `style` object when dragging is active and the row is the dragged item:

```tsx
const style = {
  transform: CSS.Transform.toString(transform),
  transition,
  /* c8 ignore next -- isDragging=true only during active pointer drag, not exercisable in JSDOM */
  opacity: isDragging ? 0.5 : 1,
  touchAction: isDragging ? "none" : undefined,   // ADD
};
```

Applying `touch-action: none` only when `isDragging` is true avoids permanently blocking scroll on every row; horizontal table scroll remains usable when no drag is in progress.

### 2. `frontend/src/styles/index.css`

The `.admin-table__drag-handle` class (used on the `<td>` wrapping the handle span, line 115) currently has no explicit sizing rule. Add a rule below the existing `.admin-table td` block (after line 1476):

```css
/* Drag handle cell — ensure the cell itself does not constrain the 44px touch target */
.admin-table__drag-handle {
  padding: 0;
  width: 44px;
  text-align: center;
}
```

Setting `padding: 0` and `width: 44px` on the cell ensures the inline-flex span on the handle can fill the full 44×44 area without being squeezed by the default `12px 14px` cell padding.

---

## Key Design Decisions

### Why `delay: 250, tolerance: 5` and not `distance: N`?

`@dnd-kit`'s `TouchSensor` supports two activation strategies:

- `distance` — activate after the finger moves N px in any direction
- `delay + tolerance` — activate after N ms, cancelling if the finger moves more than tolerance px during the wait

The `distance` strategy is unsuitable here because on a touch device, a long-press on a table row (the natural "I want to drag this") does not involve movement — the user holds still then moves. `delay + tolerance` mirrors native iOS/Android long-press-to-drag behaviour and is the approach recommended in the `@dnd-kit` documentation for lists embedded in scrollable containers.

### Why `touch-action: none` on the handle span, not the whole table?

Applying `touch-action: none` to the whole table or the `admin-table-wrapper` would disable horizontal scroll on mobile, which is needed for the wide table on narrow viewports. Scoping it to the handle span (and conditionally to the dragging row) surgically prevents the browser scroll from interfering only where a drag can actually be initiated.

### Why not switch from `PointerSensor` to a multi-touch sensor?

`PointerSensor` handles mouse and stylus correctly on desktop and does handle pointer events on touch devices in many browsers. Keeping it ensures desktop behaviour is unchanged. `TouchSensor` runs in parallel and handles the case where the browser's pointer event emulation for touch is insufficient (common on iOS Safari).

### No new npm packages required

`TouchSensor` is already shipped in `@dnd-kit/core` ^6.3.1 (the installed version). No `package.json` change is needed.

---

## Data Flow (happy path — touch drag on mobile)

1. Admin opens meeting detail page on a mobile browser.
2. Admin presses and holds the `&#x2807;` drag handle for 250 ms without moving more than 5 px.
3. `TouchSensor` fires the activation event; `@dnd-kit` marks the drag as active on that motion row.
4. `isDragging` becomes `true`; the row renders at 50% opacity and `touch-action: none` is applied.
5. Admin moves finger up or down; `@dnd-kit` updates `transform` on the dragged row via CSS transform (no DOM reorder yet).
6. Admin lifts finger; `handleDragEnd` fires, calls `arrayMove`, updates `localOrder` state, and calls `onReorder(newOrder)`.
7. The parent component sends the PATCH request to `PUT /api/admin/agms/{id}/motions/reorder`; the new order is persisted.

---

## Schema Migration Note

No schema migration required. This is a pure frontend change.

---

## E2E Test Scenarios

The drag-drop reordering journey is part of the Admin persona journey (meeting management). The existing admin motion management coverage lives in:

- `/Users/stevensun/personal/agm_survey/.worktree/feat-touch-dnd/frontend/e2e/admin/admin-general-meetings.spec.ts`
- `/Users/stevensun/personal/agm_survey/.worktree/feat-touch-dnd/frontend/e2e/workflows/admin-setup.spec.ts`

Both files must be updated to include the touch drag scenarios below — do not add a separate spec file.

### Scenario 1: Touch drag reorders motions (happy path)

**File to update:** `e2e/admin/admin-general-meetings.spec.ts`

Setup: Create a pending meeting with at least 3 motions via API. Navigate to the meeting detail page at a mobile viewport (`{ width: 390, height: 844 }` — iPhone 14 dimensions).

Steps:
1. Assert all three drag handles are visible (`data-testid="drag-handle-{id}"`).
2. Use Playwright's `page.dispatchEvent` or the `dragTo` helper with `force: true` on the handle element to simulate a touch drag of the second motion row above the first.
3. After the drag, assert that the first row now shows the motion that was previously second (check the visible motion number / title text).
4. Assert that the reorder API call was made (intercept via `page.route` or assert on the network call) and the new order is reflected after the page re-renders.

### Scenario 2: Scroll is not blocked when not dragging (regression)

**File to update:** `e2e/admin/admin-general-meetings.spec.ts`

Setup: Same as Scenario 1 (mobile viewport, meeting with 3+ motions).

Steps:
1. Scroll the page down using `page.evaluate(() => window.scrollBy(0, 300))`.
2. Assert `window.scrollY > 0` — i.e. scroll was not blocked.
3. Assert the motion rows are still present (no layout break).

### Scenario 3: Touch drag is disabled on a closed meeting

**File to update:** `e2e/admin/admin-general-meetings.spec.ts`

Setup: Create a closed meeting with motions. Navigate to it at mobile viewport.

Steps:
1. Assert drag handles are not rendered (the `{isEditable && ...}` branch renders them only when `meetingStatus` is `"open"` or `"pending"`).
2. Verify the `<th>` for the drag column is absent from the table header.

### Scenario 4: Touch drag handle meets minimum touch target size

**File to update:** `e2e/admin/admin-general-meetings.spec.ts`

Setup: Navigate to a pending meeting at mobile viewport.

Steps:
1. Locate the first drag handle element.
2. Assert `boundingBox().width >= 44` and `boundingBox().height >= 44`.

### Scenario 5: Move-to-top / move-to-bottom keyboard buttons remain functional after touch sensor addition (regression)

**File to update:** `e2e/workflows/admin-setup.spec.ts`

Setup: Existing WF2 motion management scenario.

Steps:
1. At desktop viewport, click "Move to bottom" for the first motion.
2. Assert the motion that was first is now last.
3. Assert the reorder was persisted (navigate away and back, verify order).

This scenario ensures the keyboard/button fallback is unaffected by the sensor config change.

---

## Vertical Slice Decomposition

This feature touches only the frontend. There is no backend or database slice. The entire change is a single frontend slice and can be implemented and tested as one branch.

The implementation agent should work in the worktree at:
`/Users/stevensun/personal/agm_survey/.worktree/feat-touch-dnd`

Target files:
- `frontend/src/components/admin/MotionManagementTable.tsx`
- `frontend/src/styles/index.css`
- `frontend/tests/unit/MotionManagementTable.test.tsx` (unit test updates)
- `frontend/e2e/admin/admin-general-meetings.spec.ts` (E2E updates)
- `frontend/e2e/workflows/admin-setup.spec.ts` (regression E2E)
