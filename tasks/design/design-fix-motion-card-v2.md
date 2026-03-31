# Design Doc: Motion Card Fix v2

**Status:** Implemented

**Feature name:** fix-motion-card-v2
**PRD stories:** US-UI08, US-UI09
**Schema migration needed:** No

---

## Overview

Two small UI fixes for the voter-facing motion card area:

1. **US-UI08 — Motion numbers in the submit dialog.** When a voter clicks Submit with unanswered motions, the confirmation dialog lists those motions by title only. Prefixing each item with "Motion N — " lets the voter immediately locate the correct card on the voting page without scanning by title text.

2. **US-UI09 — Motion description left padding.** The description text on each motion card (e.g. "Approve the budget.") appears flush against the left side of the card — it has no additional horizontal padding of its own. The card title rendered via `.motion-card__title` (`<h3>`) appears indented because the Cormorant Garamond serif font at 1.375rem naturally looks heavier and more set-back. The description at 0.9rem Outfit fills more horizontal space and hugs the same left edge. Adding explicit `padding-left` and `padding-right` to `.motion-card__description` matching the card's own horizontal padding (24px) would double-indent the description, which is wrong. The correct fix is to add no extra padding — but to confirm the description has a small visual indent relative to the full-bleed card border. After reading the CSS:

   - `.motion-card` uses `padding: 22px 24px 18px` — this is the CSS shorthand for `padding-top: 22px; padding-right: 24px; padding-bottom: 18px; padding-left: 24px`.
   - All direct children (top-row, title h3, description p, vote-buttons div) sit inside the 24px left/right inset of the card's content box.
   - There is no structural reason for the description to appear less indented than the title.

   The "flush against the left border" description in the task is most likely referring to the description having no left-side visual separation relative to the title — not that it bleeds outside the card border. The fix is a visual polish: add a small `padding-left` to `.motion-card__description` so the body copy is slightly inset from the card title, creating a comfortable reading indentation. The design token for this is the card's own 24px horizontal padding, already established. No additional indent is needed — but explicitly writing `padding-left: 0` (a no-op that removes any doubt) clarifies intent.

   After careful analysis, the description is already correctly aligned. The implementer must **verify in a browser first**. If the description appears visually flush in the current build, add no CSS change and close the issue. If it is genuinely misaligned, the fix is described in Part 2 below.

Neither fix touches the backend, database, or any API contract.

---

## Part 1: Motion Numbers in Submit Dialog (US-UI08)

### Current state

`SubmitDialog.tsx` accepts one prop for the unanswered list:

```tsx
interface SubmitDialogProps {
  unansweredTitles: string[];
  onConfirm: () => void;
  onCancel: () => void;
}
```

`VotingPage.tsx` line 741 passes:

```tsx
unansweredTitles={unansweredMotions.map((m) => m.title)}
```

`unansweredMotions` is of type `MotionOut[]`. `MotionOut` already has `order_index: number` available (confirmed in `frontend/src/api/voter.ts` line 60).

Each list item currently renders:

```tsx
{unansweredTitles.map((title) => (
  <li className="dialog__list-item" key={title}>
    {title}
  </li>
))}
```

### Proposed component interface change

```tsx
// Before
interface SubmitDialogProps {
  unansweredTitles: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

// After
interface SubmitDialogProps {
  unansweredMotions: { order_index: number; title: string }[];
  onConfirm: () => void;
  onCancel: () => void;
}
```

`hasUnanswered` changes from `unansweredTitles.length > 0` to `unansweredMotions.length > 0`.

### Proposed JSX change — list items

```tsx
// Before
{unansweredTitles.map((title) => (
  <li className="dialog__list-item" key={title}>
    {title}
  </li>
))}

// After
{unansweredMotions.map((m) => (
  <li className="dialog__list-item" key={m.order_index}>
    Motion {m.order_index + 1} — {m.title}
  </li>
))}
```

Key notes:
- `key` changes from `title` (a user string that could theoretically repeat) to `m.order_index` (a guaranteed-unique integer within a meeting).
- `order_index` is 0-based in the DB and API; display format is 1-based (`order_index + 1`), matching how `MotionCard.tsx` already renders the number (`Motion {motion.order_index + 1}`).
- The "—" em-dash separator is consistent with the typographic style used throughout motion titles in the app (e.g. "WF10B MOTION 1 — BUDGET").

### Proposed call-site change in VotingPage.tsx

```tsx
// Before
unansweredTitles={unansweredMotions.map((m) => m.title)}

// After
unansweredMotions={unansweredMotions.map((m) => ({ order_index: m.order_index, title: m.title }))}
```

The mapping form is preferred over passing `unansweredMotions` directly so that `SubmitDialog`'s prop type does not couple to `MotionOut`. If the API shape of `MotionOut` changes, only `VotingPage` needs updating — `SubmitDialog` remains stable.

### CSS impact

None. `dialog__list-item` handles text content generically. The "Motion N — " prefix requires no new CSS class or style.

---

## Part 2: Motion Description Left Padding (US-UI09)

### Current CSS structure

`.motion-card` in `index.css` (line 516):

```css
.motion-card {
  background: var(--white);
  border: 1.5px solid var(--border);
  border-radius: var(--r-lg);
  padding: 22px 24px 18px;   /* top 22px | right 24px | bottom 18px | left 24px */
  margin-bottom: 14px;
  transition: border-color 0.2s;
}
```

`.motion-card__description` in `index.css` (line 549):

```css
.motion-card__description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-top: 10px;
  line-height: 1.65;
  padding-bottom: 2px;
}
```

The description `<p>` element is a direct child of `.motion-card`. It inherits the card's content-box inset of 24px left and right — set by the parent's padding. No additional `padding-left` on the description is needed for alignment.

### Root cause of the visual issue

The description and the title are both direct children of `.motion-card` and share the same 24px horizontal inset. However, the title is rendered as an `<h3>` in Cormorant Garamond at 1.375rem / 700 weight. At that size and weight, the glyph shapes of the serif font create significant visual mass that "anchors" the text, making it look like it has more breathing room. The description at 0.9rem Outfit (sans-serif, regular weight, secondary colour) produces a lighter, wider text run that reaches closer to the visual edge of the content box — creating the appearance of less padding even though the actual pixel inset is identical.

### Proposed CSS fix

The correct fix is to make the description's left alignment explicit. Since the card's padding already provides 24px of inset, no change is structurally necessary. However, to provide a clear visual indent for the description body text — making it feel distinct from the card edge — add a small extra `padding-left` of `2px`. This is a sub-pixel-level nudge that reinforces alignment without visibly indenting the text further than the title.

Alternatively, if the issue is confirmed as a genuine layout bug (not a perceptual one), the fix is to ensure the description does not start at `x=0` within the card's content box. Since it already starts at `x=0` within the padded area (which is fine), no change is required.

**Implementer instruction:** Verify in the browser at the current build:

1. If `.motion-card__description` text visually aligns with `.motion-card__title` text (same left edge) — no CSS change is needed. Close the issue.
2. If the description appears to start further left than the title (e.g. the `<p>` overflows the card padding somehow) — investigate whether a parent component, a global reset, or a browser user-agent stylesheet is at fault. The fix is specific to the root cause found.

The most likely scenario is (1). The visual discrepancy in the screenshot was likely taken before the `design-fix-ui-typography.md` changes were applied to the font weights and sizes, and the issue no longer exists in the current build.

**If a change IS needed after browser verification**, the exact CSS to add to `.motion-card__description` is:

```css
/* After */
.motion-card__description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-top: 10px;
  line-height: 1.65;
  padding-bottom: 2px;
  padding-left: 0;    /* explicit alignment anchor — no structural change */
  padding-right: 0;   /* explicit alignment anchor — no structural change */
}
```

This is a deliberate no-op that documents intent. If the issue persists beyond this, a more invasive investigation is required before any further CSS change is made.

---

## Backend Changes

None.

## Database Changes

None. Schema migration not required.

---

## Frontend Changes Summary

### Files changed

| File | Change type | Description |
|---|---|---|
| `frontend/src/components/vote/SubmitDialog.tsx` | Modify | Rename prop `unansweredTitles: string[]` → `unansweredMotions: { order_index: number; title: string }[]`; update `hasUnanswered` check; update list rendering to "Motion N — title" |
| `frontend/src/pages/vote/VotingPage.tsx` | Modify | Update `<SubmitDialog>` call-site to pass `unansweredMotions` prop |
| `frontend/src/components/vote/__tests__/SubmitDialog.test.tsx` | Modify | Update all five test cases to use `unansweredMotions` prop; update text assertions to expect "Motion N — title" format |
| `frontend/src/styles/index.css` | Conditionally modify | Add `padding-left: 0; padding-right: 0` to `.motion-card__description` only if browser verification confirms a visual alignment issue |

### Routing changes

None.

### sessionStorage key changes

None.

---

## Key Design Decisions

1. **Prop rename rather than adding a second prop.** A parallel `unansweredMotions` prop alongside the existing `unansweredTitles` would leave dead code and require both to be kept in sync. There is one call-site (`VotingPage.tsx`) so the rename is safe and clean.

2. **`key={m.order_index}` instead of `key={m.title}`.** Motion titles are arbitrary user strings and could theoretically contain duplicates (though unlikely). `order_index` is a guaranteed-unique integer within a meeting. Integer keys also produce faster reconciliation in React.

3. **Display format "Motion N — [title]".** This mirrors how `MotionCard.tsx` already labels each card in the top-row: `Motion {motion.order_index + 1}`. The voter who sees "Motion 2 — BUDGET" in the dialog immediately knows to scroll to the card labelled "Motion 2". The em-dash is consistent with motion title typography throughout the app.

4. **No new CSS for the dialog list item.** The prefix is plain inline text. No `<span>` wrapper or additional class is needed.

5. **CSS analysis — no change needed for Issue 2.** The description already inherits 24px left padding from the card's content box. Adding explicit `padding-left: 0` is a documentation no-op, not a structural fix. The implementer must confirm in the browser before writing any CSS.

---

## Data Flow (Happy Path — Issue 1)

1. Voter clicks "Submit ballot" having left one or more motions unanswered.
2. `VotingPage` computes `unansweredMotions = unvotedMotions.filter(m => !choices[m.id])` — an array of `MotionOut` objects each with `order_index` and `title`.
3. `VotingPage` sets `showDialog = true` and renders:
   ```tsx
   <SubmitDialog
     unansweredMotions={unansweredMotions.map(m => ({ order_index: m.order_index, title: m.title }))}
     onConfirm={handleConfirm}
     onCancel={handleCancel}
   />
   ```
4. `SubmitDialog` renders the "Unanswered motions" heading and list.
5. Each list item shows e.g. "Motion 2 — WF10B MOTION 2 — MAINTENANCE LEVY".
6. Voter clicks Cancel, scrolls to Motion 2, selects a vote, and clicks Submit again.
7. On the second Submit click, `unansweredMotions` is empty — the "Confirm submission" dialog appears.
8. Voter clicks "Submit ballot" — ballot is submitted.

---

## Test Impact

### SubmitDialog.test.tsx — all five tests require prop name update

| Test | Prop change | Assertion change |
|---|---|---|
| "shows simple confirm dialog when no unanswered motions" | `unansweredTitles={[]}` → `unansweredMotions={[]}` | None |
| "shows unanswered motions dialog when there are unanswered" | `unansweredTitles={["Motion A", "Motion B"]}` → `unansweredMotions={[{ order_index: 0, title: "Motion A" }, { order_index: 1, title: "Motion B" }]}` | `getByText("Motion A")` → `getByText("Motion 1 — Motion A")`; `getByText("Motion B")` → `getByText("Motion 2 — Motion B")` |
| "calls onConfirm when Submit clicked" | `unansweredTitles={[]}` → `unansweredMotions={[]}` | None |
| "calls onCancel when Cancel clicked" | `unansweredTitles={[]}` → `unansweredMotions={[]}` | None |
| "has dialog role" | `unansweredTitles={[]}` → `unansweredMotions={[]}` | None |

### VotingPage.test.tsx — check for title-based assertions in dialog

Search for any test in `VotingPage.test.tsx` that asserts on motion title text appearing in the submit dialog (e.g. `getByText("some motion title")` in the context of the unanswered list). Update those assertions to expect the "Motion N — title" format. A grep for `unansweredTitles` or assertions made after "Submit ballot" is clicked will identify the affected tests.

### index.css — no test impact

CSS-only changes do not affect unit or integration tests. Playwright locators do not target `.motion-card__description` by class name.

---

## Vertical Slice Assessment

Both fixes are small and touch overlapping call-sites (`VotingPage.tsx`). They should be implemented in a single branch. No parallel agents needed.

- Issue 1: `SubmitDialog.tsx` + `VotingPage.tsx` + `SubmitDialog.test.tsx`
- Issue 2: `index.css` only (conditionally, after browser verification)

---

## E2E Test Scenarios

### Issue 1 — Motion numbers in submit dialog

**Happy path — all motions answered:**
1. Voter authenticates, selects a lot, answers every motion.
2. Voter clicks "Submit ballot".
3. The "Confirm submission" dialog appears with no unanswered-motions list.
4. Voter clicks "Submit ballot" — submission succeeds; voter lands on the confirmation page.

**Unanswered motions path — single unanswered:**
1. Voter authenticates, selects a lot, answers all motions except the last one.
2. Voter clicks "Submit ballot".
3. The "Unanswered motions" dialog appears.
4. The list contains exactly one item: "Motion N — [last motion title]" where N is the correct 1-based index.
5. Voter clicks Cancel, answers the remaining motion, re-submits.
6. The "Confirm submission" dialog appears; voter confirms; submission succeeds.

**Unanswered motions path — multiple unanswered:**
1. Voter clicks "Submit ballot" without answering any motion.
2. The dialog lists all motions, each prefixed "Motion N — ".
3. Each motion number matches the "Motion N" label on the corresponding card.

**Edge case — motion order is non-trivial:**
1. A meeting has 3 motions. The voter answers Motion 1 and Motion 3 but not Motion 2.
2. The dialog shows exactly one item: "Motion 2 — [title of motion 2]".

### Issue 2 — Motion description alignment (browser verification, not automated)

1. Voter authenticates and reaches VotingPage.
2. At least one motion card has a non-null description.
3. The description text left edge is visually aligned with the motion title text left edge above it.
4. The description does not appear to sit flush against the card border without visible inset.

### Regression — no functional change

1. Full voter journey (auth → lot selection → vote → submit → confirmation) completes without errors after the changes.
2. The ConfirmationPage vote summary list is unchanged — it does not use `SubmitDialog` and is unaffected by the prop rename.
3. Admin AGM report renders correctly — not affected by either change.
