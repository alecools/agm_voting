# Design: Voter Accessibility Improvements

**Status:** Implemented

**Feature branch:** `feat-voter-accessibility`
**Stories:** US-ACC-01, US-ACC-03, US-ACC-04, US-ACC-05, US-CQM-06, RR2-03
**Schema changes:** None required.

---

## Overview

This design doc covers six small, independent frontend improvements addressing WCAG 2.1 AA accessibility gaps, a missing CSS modifier class, and a pagination filter-reset bug. All changes are CSS/HTML/React only — no backend schema or API changes are needed.

---

## Changes

### US-ACC-01 — Lot checkboxes in `<label>` tags

**WCAG violation:** WCAG 1.3.1 (Info and Relationships) — the checkbox label text (`Lot N`) was in a sibling `<span>`, not associated with the checkbox. Clicking the text did not toggle the checkbox. Screen readers announced the checkbox via `aria-label` only, and the click target was limited to the tiny checkbox element.

**Fix:**
- In `frontend/src/pages/vote/VotingPage.tsx`, wrap each lot checkbox and its `<span class="lot-selection__lot-number">` inside a `<label htmlFor="lot-checkbox-{id}">` element.
- Remove the now-redundant `aria-label="Select Lot N"` from the `<input>` — the `<label>` text "Lot N" becomes the accessible name.
- Add `.lot-selection__label` CSS class with `display: inline-flex`, `align-items: center`, `cursor: pointer`, and `min-height: 44px` to meet WCAG 2.5.8 minimum touch target size.

**No backend changes.**

---

### US-ACC-03 — Vote buttons `:focus-visible` styles

**WCAG violation:** WCAG 2.4.7 (Focus Visible) — `.vote-btn` had no explicit `:focus-visible` outline. The browser default focus ring is removed by many CSS resets.

**Fix:**
- In `frontend/src/styles/index.css`, add after `.vote-btn:disabled`:
  ```css
  .vote-btn:focus-visible {
    outline: 3px solid var(--navy);
    outline-offset: 2px;
  }
  ```
- Uses `outline` not `border` so layout is not shifted.
- Navy (`#0C1B2E`) on the existing button background colours achieves at least 3:1 contrast against white/light-tint backgrounds.

**No backend changes.**

---

### US-ACC-04 — Colour-only indicators — add non-colour cues

**WCAG violation:** WCAG 1.4.1 (Use of Colour) — three indicators relied solely on colour:
1. Unanswered motion highlight (amber background only).
2. "Already voted" badge (grey background, no shape/text distinction).
3. Countdown timer warning (amber text, no text cue).

**Fixes:**

1. **Motion highlight "! Unanswered" badge** — in `MotionCard.tsx`, render `<span class="motion-card__unanswered-badge" aria-label="Unanswered">! Unanswered</span>` inside the top row when `highlight` is `true`. This is a text+shape indicator independent of colour. The amber left border (`border-left: 4px solid var(--amber)`) in `index.css` is retained as an additional secondary visual cue but is not the primary non-colour indicator. The `.motion-card__unanswered-badge` CSS class uses the amber palette for styling consistency while the text content satisfies WCAG 1.4.1.

2. **"Already voted" badge prefix** — in `MotionCard.tsx`, change badge text from `"Already voted"` to `"✓ Already voted"`. The `✓` glyph is a non-colour shape indicator.

3. **Countdown warning `!` prefix** — in `CountdownTimer.tsx`, add `{isWarning && <span aria-hidden="true">! </span>}` before the time digits when `isWarning` is true. The span is `aria-hidden` because the colour change and the timer role already communicate urgency to screen readers via `aria-live="polite"`; the `!` is a visual-only non-colour cue.

**No backend changes.**

---

### US-ACC-05 — OTP flow step clarity

**WCAG violation:** WCAG 3.3.2 (Labels or Instructions) — the OTP step-2 form lacked sufficient instructions explaining where to find the code and expected wait time.

**Fix:**
- In `AuthForm.tsx`, add a `<p role="status" aria-live="polite">` with text "Verification code sent to {otpEmail}. Check your email — it may take a minute to arrive." above the OTP input field (inside the `step === "code"` branch). The text includes the actual email address so the voter can confirm the code was sent to the right place.
- `role="status"` / `aria-live="polite"` ensures screen readers announce the hint text when step 2 is shown without interrupting current speech.
- Also fix `inputMode` on the OTP input from `"text"` to `"numeric"` — the OTP code is numeric and `inputMode="numeric"` triggers the numeric keyboard on mobile devices, per WCAG 1.3.4 and US-ACC-05 AC.

**No backend changes.**

---

### US-CQM-06 — `.motion-card--read-only` CSS

**Gap:** `MotionCard.tsx` already applies `.motion-card--read-only` when `readOnly={true}`, but the CSS class was undefined. Without it, read-only cards looked identical to interactive cards (only `pointer-events: none` from the inline `disabled` attribute on buttons).

**Fix:**
- In `index.css`, add after `.motion-card--highlight`:
  ```css
  .motion-card--read-only {
    opacity: 0.65;
    pointer-events: none;
  }
  .motion-card--read-only .vote-btn {
    cursor: not-allowed;
  }
  ```
- `opacity: 0.65` visually mutes the card to distinguish it from interactive cards.
- `pointer-events: none` on the card prevents any accidental click-through on the vote buttons.

**No backend changes.**

---

### RR2-03 — Filter toggle resets pagination to page 1

**Bug:** When a filter changes, the currently displayed page number may exceed the new filtered result set's total pages, resulting in an empty view.

**Analysis:** `BuildingsPage.tsx` already calls `setPage(1)` inside `handleShowArchivedChange`. `GeneralMeetingListPage.tsx` already calls `setPage(1)` in both `handleBuildingChange` and `handleStatusChange`. The page-reset logic was already correct — the missing piece was test coverage verifying the behaviour.

**Fix:** Add integration tests to `GeneralMeetingListPage.test.tsx` verifying that changing the building filter or the status filter while on page 2 resets the display to page 1.

**No code changes to the page components.** Only test additions.

**Dependency on RR2-06 (URL `page` param):** The RR2-03 acceptance criteria also require the URL `page` query param to be set to `1` (or removed) when the filter changes, so that the reset is reflected in the URL and survives a browser refresh. This sub-requirement is **not implemented in this branch** — it is delivered by RR2-06 on the `feat/admin-ux` branch, which introduces full URL-based pagination state (`useSearchParams` for `page`). Once RR2-06 merges, the `page` param will be reset to `1` whenever the building or status filter changes, fully satisfying the RR2-03 AC. This branch satisfies the in-memory `setPage(1)` aspect of the AC, and adds test coverage for it.

---

## Files Changed

| File | Type | Change |
|------|------|--------|
| `frontend/src/pages/vote/VotingPage.tsx` | React | Wrap lot checkboxes in `<label>` elements (US-ACC-01) |
| `frontend/src/components/vote/MotionCard.tsx` | React | Add `✓` prefix to "Already voted" badge (US-ACC-04) |
| `frontend/src/components/vote/CountdownTimer.tsx` | React | Add `!` prefix span when `isWarning` (US-ACC-04) |
| `frontend/src/components/vote/AuthForm.tsx` | React | Add OTP helper text with `role="status"` (US-ACC-05) |
| `frontend/src/styles/index.css` | CSS | Add `:focus-visible`, `.motion-card--read-only`, left border on highlight, `.lot-selection__label` |
| `frontend/src/components/vote/__tests__/MotionCard.test.tsx` | Test | Tests for `✓` badge, `--read-only` class, highlight border class |
| `frontend/src/components/vote/__tests__/AuthForm.test.tsx` | Test | Tests for OTP hint text |
| `frontend/src/components/vote/__tests__/CountdownTimer.test.tsx` | Test | Tests for `!` prefix on warning |
| `frontend/src/pages/vote/__tests__/VotingPage.test.tsx` | Test | Tests for label-wrapped checkboxes; update "Already voted" → "✓ Already voted" strings |
| `frontend/src/pages/admin/__tests__/GeneralMeetingListPage.test.tsx` | Test | Tests for RR2-03 page-reset on filter change |

---

## No Schema or Migration Required

All changes are frontend-only CSS and React. No Alembic migrations, no backend model or router changes.
