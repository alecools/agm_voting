# Design: Bug Fix — Motion Count Starts at 1 Not 0

## Overview

On the voting screen, each motion card displays "Motion N" where N is the raw `order_index` value from the API response. Because `order_index` is a zero-based integer (the first motion has `order_index: 0`), voters see "Motion 0", "Motion 1", "Motion 2" — which looks wrong. Motions should be labelled "Motion 1", "Motion 2", "Motion 3".

This is a single-line display fix in `MotionCard.tsx`. No backend changes, no database changes, no migration required.

---

## Root Cause

**File:** `frontend/src/components/vote/MotionCard.tsx`, line 41

```tsx
<p className="motion-card__number">Motion {motion.order_index}</p>
```

`motion.order_index` is the zero-based database ordinal. The display label adds nothing to it, so the first motion shows "Motion 0".

---

## Fix

Change the display expression from `motion.order_index` to `motion.order_index + 1`:

```tsx
// Before
<p className="motion-card__number">Motion {motion.order_index}</p>

// After
<p className="motion-card__number">Motion {motion.order_index + 1}</p>
```

This is the complete code change. One line, one file.

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/components/vote/MotionCard.tsx` | line 41: `motion.order_index` → `motion.order_index + 1` |

---

## Test Updates Required

### Unit tests — `MotionCard.test.tsx`

The test fixture at the top of `frontend/src/components/vote/__tests__/MotionCard.test.tsx` defines motions with `order_index: 0`, `order_index: 1`, and `order_index: 2`. After the fix, any test that asserts on the rendered "Motion N" text must expect N+1.

Currently no existing test in `MotionCard.test.tsx` explicitly asserts on the "Motion N" label text — the tests focus on title, description, buttons, badges, and highlight state. However, a new test must be **added** to verify the 1-based display behaviour:

```tsx
it("displays motion number as order_index + 1 (1-based)", () => {
  render(
    <MotionCard
      motion={{ ...motion, order_index: 0 }}
      choice={null}
      onChoiceChange={() => {}}
      disabled={false}
      highlight={false}
    />
  );
  expect(screen.getByText("Motion 1")).toBeInTheDocument();
});

it("displays correct 1-based number for order_index 4", () => {
  render(
    <MotionCard
      motion={{ ...motion, order_index: 4 }}
      choice={null}
      onChoiceChange={() => {}}
      disabled={false}
      highlight={false}
    />
  );
  expect(screen.getByText("Motion 5")).toBeInTheDocument();
});
```

### Integration tests — `VotingPage.test.tsx`

The `VotingPage.test.tsx` MSW handler returns motions with `order_index: 0` and `order_index: 1`. If any integration test asserts on visible "Motion 0" or "Motion 1" text as a motion label, it must be updated to "Motion 1" and "Motion 2" respectively.

Searching the test file: the existing mock motions use `order_index: 0` and `order_index: 1`. A targeted search for any `getByText("Motion 0")` or `toHaveTextContent("Motion 0")` assertions is needed. If present, update them.

### E2E tests — Playwright specs

The Playwright E2E specs use `order_index: 1` and `order_index: 2` when seeding motions (e.g. `multi-lot-voting.spec.ts`, `proxy-voting.spec.ts`, `global-setup.ts`). With 1-based display, a motion with `order_index: 1` will show "Motion 2" on screen. Any E2E assertion that matches on visible label text like `page.getByText("Motion 1")` must be updated to `page.getByText("Motion 2")`.

A grep of the E2E specs for literal text assertions on motion labels is needed before implementation. The E2E specs primarily identify motions by their title text (e.g. "Motion 1 — Annual Budget") rather than the "Motion N" label, so direct impact is expected to be low — but must be verified.

---

## Key Design Decision

**Why not fix `order_index` to be 1-based in the database?**

`order_index` is a sort key — its absolute value is irrelevant to the data model. Changing it to be 1-based in the database would require:
- A data migration for all existing motion rows
- An Alembic migration
- Backend changes to how motions are created (starting from 1 rather than 0)
- Updates to all tests that seed `order_index: 0`

Adding `+ 1` at the display layer is the correct separation of concerns: the data model stays clean, the display is human-friendly. This is consistent with how most list-indexing is handled in UI (array indices are 0-based; human-readable counts are 1-based).

---

## Data Flow

No data flow change. This is a pure rendering change. The API response shape is unchanged; `order_index` in the database and API remains 0-based.

---

## Schema Migration Note

No database changes. Schema migration required: **no**.

---

## E2E Test Scenarios

### Happy path

**MC-FIX-01: First motion shows "Motion 1" not "Motion 0"**
- Authenticate as a voter for a meeting with at least two motions (seeded with `order_index: 0` and `order_index: 1`)
- Navigate to the voting page
- Assert that the first motion card displays the text "Motion 1"
- Assert that the second motion card displays the text "Motion 2"
- Assert that "Motion 0" does NOT appear anywhere on the page

### Boundary values

**MC-FIX-02: Single motion meeting**
- Seed a meeting with exactly one motion (`order_index: 0`)
- Navigate to the voting page
- Assert the card displays "Motion 1"

**MC-FIX-03: Meeting with many motions**
- Seed a meeting with 10 motions (`order_index: 0` through `order_index: 9`)
- Navigate to the voting page
- Assert the last motion card displays "Motion 10"

### Regression

**MC-FIX-04: All other motion card content is unaffected**
- After the fix, confirm that motion title, description, type badge, and vote buttons render correctly for a motion with `order_index: 0`
- Assert "Approve budget" title and "General" badge are still shown alongside "Motion 1"

---

## Vertical Slice Note

This slice is **completely independent** of Slice A (bundle optimisation). No shared files, no shared state. Both slices can be implemented in parallel on separate branches.
