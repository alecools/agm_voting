# Design: Fix Motion Labels on Confirmation Page and SubmitDialog

## Overview

After the `feat/custom-motion-number-and-reorder` feature added `motion_number`, the voter-facing voting page was updated to display `"MOTION {motion_number}"` as the heading for each motion card. However, two related surfaces were missed:

1. **SubmitDialog** — the list of unanswered motions shown when the voter clicks Submit with some motions unanswered. These items still used `order_index + 1` (the old field name) causing "Motion NaN" to appear.
2. **Confirmation page** (`my-ballot` response) — the `BallotVoteItem` in `my-ballot` responses included `motion_number` in the schema but the confirmation page component was not rendering it as a `"MOTION {motion_number}"` prefix, so it fell back to the old positional display.

This is a frontend-only fix — no backend or database changes required.

---

## Root Cause

### SubmitDialog — "Motion NaN"

`VotingPage.tsx` built the `unansweredMotions` prop for `SubmitDialog` as:

```tsx
unansweredMotions={unansweredMotions.map((m) => ({
  order_index: m.order_index,   // BUG: field does not exist on MotionOut
  title: m.title,
}))}
```

`MotionOut` (voter API) uses `display_order`, not `order_index`. `m.order_index` is `undefined`, and `undefined + 1` produces `NaN` in the dialog label.

### Confirmation page — no motion_number prefix

The confirmation page read `BallotVoteItem.motion_number` from the `my-ballot` response but rendered the motion label as a bare positional number, not as `"MOTION {motion_number}"`.

---

## Database Changes

None.

---

## Backend Changes

None. `motion_number` was already present in all relevant response schemas.

---

## Frontend Changes

### `frontend/src/components/vote/SubmitDialog.tsx`

- Change the prop type for unanswered motions from `{ order_index: number; title: string }[]` to `{ display_order: number; motion_number: string | null; title: string }[]`.
- Update the list item render: display `"MOTION {motion_number || display_order} — {title}"`.

### `frontend/src/pages/vote/VotingPage.tsx`

- Update the `unansweredMotions` map passed to `SubmitDialog`:
  ```tsx
  unansweredMotions={unansweredMotions.map((m) => ({
    display_order: m.display_order,
    motion_number: m.motion_number,
    title: m.title,
  }))}
  ```

### `frontend/src/pages/vote/ConfirmationPage.tsx` (or equivalent)

- Update the motion label render in the submitted ballot list: use `"MOTION {item.motion_number || item.display_order}"` as the heading for each row, consistent with the voting page label.

---

## Key Design Decisions

- **Consistent label across all surfaces** — `"MOTION {motion_number}"` is the canonical voter-facing label. All three surfaces (voting page, SubmitDialog, confirmation page) must use the same logic.
- **Fallback for null** — motions predating the auto-assign feature may still have `motion_number = null`. The fallback `motion_number || display_order` handles these gracefully.

---

## Schema Migration Note

**Schema migration needed: NO.**

---

## E2E Test Scenarios

### Affected journeys: Voter (voting → confirmation)

The existing voter voting E2E spec must be updated:

#### Happy path
- **SC-CL-01**: Voter with 3 motions (motion_numbers "A", "B", "C") submits without answering motion "B". The SubmitDialog shows "MOTION B — [title]" in the unanswered list.
- **SC-CL-02**: After full submission, the confirmation page shows each motion as "MOTION {motion_number} — [choice]".

#### Edge cases
- **SC-CL-03**: Motion with `motion_number = null` (legacy). SubmitDialog and confirmation page show "MOTION {display_order}" as fallback.
