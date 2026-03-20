# Design Doc: Fix UI Typography

**Feature name:** fix-ui-typography
**PRD stories:** US-UI06, US-UI07
**Schema migration needed:** No

---

## Overview

This doc covers two related CSS-only visual polish changes:

1. **Motion card typography (US-UI06)** — The voter-facing motion card has an underweighted title, inconsistent description spacing, and a missing CSS rule for the "Already voted" badge shown when `readOnly={true}`.

2. **Admin label typography consistency (US-UI07)** — The app uses several CSS classes that are semantically equivalent "uppercase label" text (table column headers, card section headers, stats labels, form labels, section labels). They share the same intent (small, bold, uppercase, muted) but have subtle inconsistencies across: `font-family` (Outfit vs inherited Cormorant Garamond on `<h3>` elements), `letter-spacing` (0.07em / 0.08em / 0.09em / 0.10em / 0.12em depending on class), and `font-size` (0.65rem / 0.68rem / 0.7rem / 0.75rem). This produces visual inconsistency across the admin UI that grows more noticeable as the app adds pages.

Neither fix touches any TypeScript, JSX, backend code, or test files.

---

## Part 1: Motion Card Typography (US-UI06)

### Current Structure

```
div.motion-card  (modifier: --highlight, --read-only)
  div.motion-card__top-row
    p.motion-card__number        "Motion 1"
    span.motion-type-badge       "General" | "Special"
    span.motion-card__voted-badge  (only when readOnly=true) "Already voted"
  h3.motion-card__title          e.g. "WF10B MOTION 1 — BUDGET"
  p.motion-card__description     (optional) e.g. "Approve the budget."
  div.vote-buttons
    button.vote-btn--yes / --no / --abstained
```

### Current CSS for affected classes

| Class | Property | Current value |
|---|---|---|
| `.motion-card__title` | `font-family` | `'Cormorant Garamond', serif` |
| `.motion-card__title` | `font-size` | `1.1875rem` |
| `.motion-card__title` | `font-weight` | `600` |
| `.motion-card__title` | `color` | `var(--text-primary)` |
| `.motion-card__title` | `line-height` | `1.35` |
| `.motion-card__description` | `margin-top` | `7px` |
| `.motion-card__description` | `line-height` | `1.6` |
| `.motion-card__voted-badge` | _(entire rule missing)_ | _(renders as unstyled inline text)_ |

### Proposed Changes — Motion Card

**Change 1: `.motion-card__title` — increase prominence**

```css
/* Before */
.motion-card__title {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.1875rem;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
}

/* After */
.motion-card__title {
  font-family: 'Cormorant Garamond', serif;
  font-size: 1.375rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.3;
  margin-top: 4px;
}
```

- `1.375rem` gives the title clear dominance over the 0.7rem "Motion N" label, matching the weight of other voter-facing headings (`.lot-selection__title` is 1.5rem, `.auth-card__title` is 1.75rem). At 1.375rem it is clearly a heading without being as large as a page-level title.
- `font-weight: 700` (from 600) provides visible hierarchy over the description (0.9rem, secondary colour) and vote buttons.
- `margin-top: 4px` separates the top-row metadata from the primary label.

**Change 2: `.motion-card__description` — normalise spacing**

```css
/* Before */
.motion-card__description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-top: 7px;
  line-height: 1.6;
}

/* After */
.motion-card__description {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-top: 10px;
  line-height: 1.65;
  padding-bottom: 2px;
}
```

- `margin-top: 10px` (from 7px) creates better vertical rhythm between the title and description.
- `line-height: 1.65` aligns with the global `p { line-height: 1.65 }` reset rule.
- `padding-bottom: 2px` prevents the text baseline from sitting flush against the `margin-top: 18px` of `.vote-buttons`.

**Change 3: `.motion-card__voted-badge` — add missing rule**

This class is used in `MotionCard.tsx` (line 49) but has no CSS definition. It renders as unstyled plain text. Add after `.motion-type-badge--special`:

```css
.motion-card__voted-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: #F0EFEE;
  color: var(--text-muted);
  border: 1px solid var(--border);
}
```

Matches the grey pill style of `.lot-selection__badge--submitted` and `.status-badge--closed` — consistent "done/neutral" semantic colour.

---

## Part 2: Admin Label Typography Consistency (US-UI07)

### Full Audit of Uppercase Label Classes

The following classes all implement the same design intent — small, uppercase, bold, muted tracking labels — but have inconsistent values.

| Class | Used on element | `font-family` (effective) | `font-size` | `font-weight` | `letter-spacing` | `color` | Pages/components |
|---|---|---|---|---|---|---|---|
| `.admin-table th` | `<th>` | Outfit (inherited from body) | 0.7rem | 700 | 0.09em | `--text-muted` | All admin tables (LotOwnerTable, GeneralMeetingTable, BuildingTable, AGMReportView) |
| `.admin-card__title` | `<h3>` | **Cormorant Garamond** (inherited from `h1-h5` rule) | 0.7rem | 700 | **0.10em** | `--text-muted` | BuildingCSVUpload, ProxyNominationsUpload, FinancialPositionUpload, BuildingCSVUpload, AGMReportView, GeneralMeetingDetailPage (Add Motion modal) |
| `.admin-stats__label` | `<span>` | Outfit (inherited) | 0.68rem | 700 | 0.10em | `--text-muted` | GeneralMeetingDetailPage stats bar |
| `.admin-meta__label` | `<span>` | Outfit (inherited) | 0.75rem | 600 | 0.07em | `--text-muted` | GeneralMeetingDetailPage meta row |
| `.field__label` | `<label>` | Outfit (inherited) | 0.75rem | 700 | 0.09em | `--text-secondary` | All admin forms (CreateGeneralMeetingPage, GeneralMeetingListPage filters, GeneralMeetingDetailPage modals) |
| `.section-label` | `<p>` or `<div>` | Outfit (inherited) | 0.7rem | 700 | 0.12em | `--text-muted` | Various |
| `.motion-entry__header` | `<div>` | Outfit (inherited) | 0.7rem | 700 | 0.10em | `--text-muted` | MotionEditor (admin) |
| `.vote-summary__heading` | class | Outfit (inherited) | 0.7rem | 700 | 0.10em | `--text-muted` | ConfirmationPage (voter) |
| `.vote-meta__label` | class | Outfit (inherited) | 0.75rem | 600 | 0.07em | `--text-muted` | ConfirmationPage (voter) |
| `.agm-header__building` | `<div>` | Outfit (inherited) | 0.7rem | 700 | 0.14em | `--gold-light` (on dark bg) | VotingPage header |
| `.agm-header__timer-label` | `<span>` | Outfit (inherited) | 0.65rem | 700 | 0.14em | white 38% opacity (dark bg) | VotingPage header |
| `.auth-card__building` | `<div>` | Outfit (inherited) | 0.7rem | 700 | 0.14em | `--gold` | AuthPage |
| `.hero__badge` | `<div>` | Outfit (inherited) | 0.7rem | 700 | 0.15em | `--gold-light` (on dark bg) | BuildingSelectPage |
| `.admin-sidebar__role` | `<div>` | Outfit (inherited) | 0.65rem | 700 | 0.12em | white 30% opacity (dark bg) | Admin sidebar |

### Root Cause Analysis

There are two distinct problems:

**Problem A — Font family override on `<h3>` elements:**
The global rule `h1, h2, h3, h4, h5 { font-family: 'Cormorant Garamond', Georgia, serif; }` causes any `<h3>` using `.admin-card__title` to render in the serif display font instead of Outfit. All other label classes use non-heading elements (`<span>`, `<div>`, `<label>`, `<td>`) and correctly inherit Outfit from `body`. This is the primary visual inconsistency: the import card section headers and the AGMReportView motion title headers look noticeably different from everything else in the admin label system.

**Problem B — Letter-spacing fragmentation:**
The label classes use five different letter-spacing values: 0.07em, 0.08em, 0.09em, 0.10em, and 0.12em. The dominant value used on the most-frequently-seen classes (`.admin-table th`, `.field__label`) is 0.09em. The outliers are:
- `.admin-card__title`: 0.10em
- `.admin-stats__label`: 0.10em
- `.motion-entry__header`: 0.10em
- `.vote-summary__heading`: 0.10em
- `.section-label`: 0.12em
- `.admin-meta__label`, `.vote-meta__label`: 0.07em

Note: the dark-background labels (`.agm-header__building`, `.agm-header__timer-label`, `.auth-card__building`, `.hero__badge`, `.admin-sidebar__role`) use higher letter-spacing (0.12–0.15em), which is appropriate for reversed-out text and should NOT be changed.

### Proposed Changes — Label Consistency

The changes target the admin UI label classes. Dark-background voter-facing labels are intentionally excluded — their higher letter-spacing is a design choice for legibility on coloured backgrounds.

**The canonical values for an admin label are:**
- `font-family: 'Outfit', system-ui, sans-serif` (explicit override to resist `h1-h5` inheritance)
- `font-size: 0.7rem`
- `font-weight: 700`
- `letter-spacing: 0.09em`
- `color: var(--text-muted)`

**Change A: `.admin-card__title` — fix font-family and letter-spacing**

```css
/* Before */
.admin-card__title {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  margin: 0;
}

/* After */
.admin-card__title {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-muted);
  margin: 0;
  font-family: 'Outfit', system-ui, sans-serif;
}
```

This is the most impactful single change: it fixes every `<h3 className="admin-card__title">` across BuildingCSVUpload, ProxyNominationsUpload, FinancialPositionUpload, BuildingCSVUpload, AGMReportView (motion result cards), and the Add Motion modal in GeneralMeetingDetailPage.

**Change B: `.admin-stats__label` — align letter-spacing**

```css
/* Before */
.admin-stats__label {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
}

/* After */
.admin-stats__label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-muted);
}
```

- `font-size` corrected from 0.68rem to 0.7rem — the 0.02rem difference is invisible but the inconsistency is needless.
- `letter-spacing` aligned to 0.09em.

**Change C: `.section-label` — align letter-spacing**

```css
/* Before */
.section-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-muted);
  margin-bottom: 14px;
}

/* After */
.section-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-muted);
  margin-bottom: 14px;
}
```

**Change D: `.motion-entry__header` — align letter-spacing**

```css
/* Before */
.motion-entry__header {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  margin-bottom: 12px;
}

/* After */
.motion-entry__header {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-muted);
  margin-bottom: 12px;
}
```

**Change E: `.vote-summary__heading` — align letter-spacing**

This class is on the voter-facing ConfirmationPage. The heading is "Your votes" — a label, not a dark-background special label, so it should conform to the canonical 0.09em.

```css
/* Before */
.vote-summary__heading {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

/* After */
.vote-summary__heading {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-muted);
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
```

### What is NOT changed

The following label-style classes are intentionally left at their current values because they serve different contexts:

| Class | Reason to exclude |
|---|---|
| `.admin-meta__label` | 0.07em is lower tracking; these labels sit inline next to values in the meta row and wider tracking would crowd the adjacent text |
| `.vote-meta__label` | Same — inline pair-label context |
| `.field__label` | 0.09em is already correct; no change needed |
| `.admin-table th` | 0.09em is already correct; no change needed |
| `.agm-header__building`, `.agm-header__timer-label`, `.auth-card__building`, `.hero__badge`, `.admin-sidebar__role` | Dark-background labels; 0.12–0.15em tracking is appropriate for reversed-out text — intentional design decision |
| `.motion-card__number` | 0.12em on dark monospace; intentional — this label is styled differently from the admin label system |
| `.motion-type-badge` | 0.08em — this is a pill badge, not a column header; slightly tighter tracking reads better at the small pill size |

---

## Summary of All CSS Changes

All changes are to `frontend/src/styles/index.css` only. No `.tsx` files change.

| Class | Properties changed |
|---|---|
| `.motion-card__title` | `font-size` 1.1875rem → 1.375rem; `font-weight` 600 → 700; `line-height` 1.35 → 1.3; add `margin-top: 4px` |
| `.motion-card__description` | `margin-top` 7px → 10px; `line-height` 1.6 → 1.65; add `padding-bottom: 2px` |
| `.motion-card__voted-badge` | New rule — grey pill badge style |
| `.admin-card__title` | Add `font-family: 'Outfit', system-ui, sans-serif`; `letter-spacing` 0.10em → 0.09em |
| `.admin-stats__label` | `font-size` 0.68rem → 0.7rem; `letter-spacing` 0.10em → 0.09em |
| `.section-label` | `letter-spacing` 0.12em → 0.09em |
| `.motion-entry__header` | `letter-spacing` 0.10em → 0.09em |
| `.vote-summary__heading` | `letter-spacing` 0.10em → 0.09em |

---

## No Functional Changes

- No props, component interfaces, or API calls are modified.
- No routes, state management, or DOM structure changes.
- No `data-testid` attributes change.
- No backend changes.

---

## Test Impact

### Unit tests

No test changes are required for any of the unit test files. The existing test suites:
- Assert on class names, text content, ARIA attributes, and user interactions — not on `font-family`, `font-size`, `letter-spacing`, or pixel dimensions.
- Do not use snapshot testing (no `toMatchSnapshot` calls exist in the codebase).

Specifically verified:
- `MotionCard.test.tsx` — all assertions on class names and text content are unaffected.
- `LotOwnerCSVUpload.test.tsx`, `ProxyNominationsUpload.test.tsx`, `FinancialPositionUpload.test.tsx` — assert on upload result text, not card header typography.
- `AGMReportView.test.tsx` — asserts on motion titles and tally values, not heading font.
- `BuildingCSVUpload.test.tsx` — same pattern.

### Integration and E2E tests

No changes needed. Playwright locators use `getByRole`, `getByLabel`, and `getByText`. No locator targets a CSS class-name used purely for styling (none of the changed classes are used as selectors in the E2E spec).

---

## Key Design Decisions

1. **Fix `font-family` on `.admin-card__title` rather than changing `<h3>` to another element.** `<h3>` is semantically correct for a card section title and benefits screen readers. The right fix is an explicit `font-family` override in CSS.

2. **Canonical letter-spacing is 0.09em, not 0.10em.** The 0.09em value is used by the two most visible and most frequently rendered label classes — `.admin-table th` and `.field__label`. Aligning outliers to 0.09em is less disruptive than changing the established baseline.

3. **Dark-background labels excluded from standardisation.** Labels on navy/dark backgrounds (header, sidebar, voter auth card, hero badge) intentionally use higher tracking (0.12–0.15em) for legibility of reversed-out text. This is a known and correct differentiation — not an inconsistency.

4. **`.admin-meta__label` and `.vote-meta__label` excluded.** These labels appear inline, immediately followed by a value. Lower tracking (0.07em) prevents the label from visually dominating its paired value. Changing these to 0.09em would make "Building" and "Meeting" feel too prominent next to their values.

5. **Single CSS file — no new utility classes.** Adding a utility class (e.g. `.ui-label`) and applying it everywhere would require touching many `.tsx` files and falls outside the scope of a CSS-only polish fix. Targeted fixes to each class are simpler and safer.

---

## Data Flow

Not applicable — pure CSS change.

---

## Vertical Slice Assessment

All changes are in one file (`index.css`). This is a single slice. No backend work. No parallel agents needed.

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/styles/index.css` | All changes described above |

---

## E2E Test Scenarios

These scenarios confirm the visual changes do not break any voter or admin journey. No new E2E tests are required for CSS-only fixes — they are covered by the existing suite.

### Voter journey — motion card

1. Voter authenticates and reaches the voting page. Motion cards render with title, optional description, and vote buttons.
2. Voter selects a choice. The selected button shows pressed state; card title, description, and badge remain correctly positioned.
3. Voter on a read-only card (already submitted) sees the "Already voted" badge as a visible grey pill in the top row. Vote buttons are disabled.
4. Voter attempts to submit with an unanswered motion. The card gets `--highlight` amber style; title and vote buttons remain accessible.
5. Motion with `description: null` renders without an empty paragraph.

### Voter journey — confirmation page

1. After submission, the ConfirmationPage renders the vote summary section.
2. The "Your votes" heading (`.vote-summary__heading`) is visible with correct muted uppercase style.
3. The vote meta labels (`.vote-meta__label`) are visible inline with their values.

### Admin journey — Building Detail page

1. Admin navigates to Building Detail. Lot owner table renders with column headers in uppercase sans-serif style.
2. Import cards (Import Lot Owners, Import Proxy Nominations, Import Financial Positions) each show their section title in matching sans-serif uppercase style — visually consistent with the table column headers.
3. Admin uploads a file — success/error message appears correctly.

### Admin journey — General Meeting Detail page

1. Admin navigates to a meeting. Stats bar (Eligible voters, Submitted, Participation) shows labels in uppercase sans-serif style.
2. Results Report section shows motion result cards. Each card header (motion title rendered via `.admin-card__title`) is now in Outfit sans-serif, matching the table column headers above.
3. Motion visibility table renders with column headers in uppercase sans-serif.

### Admin journey — Buildings page

1. Admin navigates to Buildings page. Building table renders with column headers.
2. "Import Buildings" card header is visible and consistent with other import card headers.

### Admin journey — General Meetings list page

1. Admin navigates to General Meetings list. Filter labels ("Building", "Status") rendered via `.field__label` are visible.
2. Table column headers are visible and consistent.
