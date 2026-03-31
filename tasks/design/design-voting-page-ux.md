# Design: Voting Page UX Improvements

**Status:** Implemented

## Overview

Six UX improvements to the voting page, implemented on branch `fix/voting-page-ux`. No database schema changes or new backend endpoints are required — all changes are frontend-only.

---

## Changes

### 1. Sidebar layout (replaces lot gate)

**Before:** Multi-lot voters saw a full-screen "Your Lots" panel with a "Start Voting" button. They had to confirm their lot selection before seeing motions.

**After:** A two-column layout is always shown for multi-lot voters. The left column (`voting-layout__sidebar`) lists lots with checkboxes; the right column (`voting-layout__main`) shows motions immediately. The `lotsConfirmed` state is removed entirely. The no-selection guard (must pick at least one lot) moves to `handleSubmitClick`.

Single-lot voters always see a full-width motions column. Single-lot proxy voters see a compact inline lot info strip above the motions.

**Files changed:**
- `src/pages/vote/VotingPage.tsx` — removed `lotsConfirmed` state and `handleStartVoting`, rewrote lot panel as `sidebarContent`, added `showSidebar` flag, added single-lot-proxy inline strip
- `src/styles/index.css` — added `.voting-layout`, `.voting-layout__sidebar`, `.voting-layout__main` with responsive breakpoint at 640px
- `src/pages/vote/__tests__/VotingPage.test.tsx` — updated all tests expecting the gate/button; added sidebar and inline-strip tests

### 2. Proxy badge text

**Before:** Lot list items showed the badge text "Lot X via Proxy" (lot number duplicated).

**After:** Badge text is simply "via Proxy".

**Files changed:**
- `src/pages/vote/VotingPage.tsx` — changed badge content to `"via Proxy"`
- `src/pages/vote/__tests__/VotingPage.test.tsx` — updated badge assertions
- `frontend/e2e/proxy-voting.spec.ts` — updated E2E assertions

### 3. In-arrear restriction moved to backend-only

**Before:** The frontend blocked voters from selecting General Motion choices if any of their lots were in arrear. The `MotionCard` accepted `inArrearLocked` and `onInArrearClick` props; clicking a General Motion button while locked showed a blocking modal.

**After:** The frontend does not block any vote choices. The backend already enforces per-lot `not_eligible` at ballot submission time in `voting_service.py` (checks `financial_position_snapshot`). Vote buttons are always interactive regardless of in-arrear status.

**Files changed:**
- `src/components/vote/MotionCard.tsx` — removed `inArrearLocked`, `onInArrearClick`, `meetingId` props; removed locked logic and blocking modal trigger
- `src/components/vote/__tests__/MotionCard.test.tsx` — removed in-arrear locking tests; added "vote buttons are never aria-disabled" test
- `src/pages/vote/VotingPage.tsx` — removed in-arrear state (`inArrearMotionId`, modal); removed `handleInArrearGeneralMotionClick`; removed those props from `MotionCard` render
- `src/pages/vote/__tests__/VotingPage.test.tsx` — updated in-arrear tests; updated E2E
- `frontend/e2e/in-arrear-voting.spec.ts` — updated to reflect interactive buttons

### 4. In-arrear informational warning banner

**Before:** No in-arrear information was shown to the voter on the voting page.

**After:** An amber banner appears in the motions column when any selected lots are in arrear. Two variants:
- **"all"**: All selected lots are in arrear — "All your selected lots are in arrear. You may only vote on Special Motions — General Motion votes will be recorded as not eligible."
- **"mixed"**: Some selected lots in arrear, some normal — "Some of your selected lots are in arrear. Your votes on General Motions will not count for in-arrear lots — they will be recorded as not eligible. Votes for all other lots will be recorded normally."

Banner is purely informational (`role="note"`), no blocking behaviour.

`arrearBannerMode` is derived from `selectedLots` (lots whose IDs are in `selectedIds`). The banner re-computes on every checkbox toggle.

**Files changed:**
- `src/pages/vote/VotingPage.tsx` — added `arrearBannerMode` derived value; added `.arrear-notice` banner JSX with `data-testid="arrear-banner"`
- `src/styles/index.css` — added `.arrear-notice` CSS block (amber background, amber border, rounded corners)
- `src/pages/vote/__tests__/VotingPage.test.tsx` — added 6 banner tests: no banner (normal lots), single in-arrear lot shows banner, multi-lot all-in-arrear, multi-lot mixed, banner updates on toggle, deselecting only normal lots promotes to "all"

### 5. Remove draft auto-save

**Before:** `MotionCard` called `useAutoSave` on every choice change, debouncing a `PUT /api/general-meeting/{id}/draft` request. `VotingPage` loaded drafts on mount via `fetchDrafts` and restored choices from the server response. `handleConfirm` flushed the debounce before submitting.

**After:** Vote choices live entirely in React state (`choices` record in `VotingPage`). No draft reads or writes happen. `handleConfirm` calls `submitMutation.mutate()` directly.

The `useAutoSave` hook and `SaveIndicator` component remain in the codebase (other consumers may exist) but are no longer imported by `MotionCard` or `VotingPage`. Their coverage entries are removed from `vite.config.ts` include/thresholds.

**Files changed:**
- `src/components/vote/MotionCard.tsx` — removed `useAutoSave` import and call; removed `SaveIndicator` import and render; removed `meetingId` prop
- `src/pages/vote/VotingPage.tsx` — removed `fetchDrafts` and `saveDraft` imports; removed draft `useQuery` and restoration `useEffect`; `handleConfirm` submits directly
- `src/api/voter.ts` — removed `fetchDrafts` function and its sole-use types `DraftItem` and `DraftsResponse`; kept `DraftSaveRequest`, `DraftSaveResponse`, `saveDraft` (still used by `useAutoSave`)
- `vite.config.ts` — removed `src/hooks/useAutoSave.ts` from coverage `include` and `thresholds`
- `src/components/vote/__tests__/MotionCard.test.tsx` — replaced all draft/save tests with "does not show a save indicator" test
- `src/pages/vote/__tests__/VotingPage.test.tsx` — replaced draft restore/auto-save/flush tests with tests confirming no server calls happen and submit fires directly

### 6. Submit directly from React state

This is a consequence of change 5. Previously, `handleConfirm` called `saveDraft` to flush the debounce, then `submitMutation.mutate()`. Now `handleConfirm` calls `submitMutation.mutate()` directly. The mutation reads `sessionStorage` for `lot_owner_ids` (set by `handleSubmitClick` for multi-lot voters).

---

## Testing

All changes are covered at 100% line coverage. No new backend tests are needed (backend in-arrear enforcement was already tested).

| File | Tests added/changed |
|---|---|
| `MotionCard.test.tsx` | Full rewrite — removed draft tests, added no-save-indicator, no-aria-disabled, motion-type-badge tests |
| `VotingPage.test.tsx` | Updated sidebar/gate tests, proxy badge, in-arrear banner (6 new tests), draft removal tests |
| `voter.ts` | Covered 100% after `fetchDrafts` removal |

---

## CSS additions

```css
/* Two-column layout */
.voting-layout { display: flex; gap: 24px; align-items: flex-start; }
.voting-layout__sidebar { flex: 0 0 260px; }
.voting-layout__main { flex: 1; min-width: 0; }
@media (max-width: 640px) { .voting-layout { flex-direction: column; } .voting-layout__sidebar { flex: unset; width: 100%; } }

/* In-arrear informational banner */
.arrear-notice {
  background: var(--amber-bg, #FFF8E6);
  border: 1.5px solid var(--amber, #F59E0B);
  border-radius: var(--r-lg, 8px);
  padding: 12px 16px;
  font-size: 0.875rem;
  color: var(--text-primary, #111827);
  margin-bottom: 16px;
}
```

---

## No backend changes

All six changes are frontend-only. The backend `POST /api/general-meeting/{id}/submit` endpoint already handles:
- Per-lot `not_eligible` recording for in-arrear lots on General Motions (`voting_service.py`)
- 409 on duplicate submission
- 403 on closed meeting

The `PUT /api/general-meeting/{id}/draft` endpoint remains in the backend (not removed) in case it is used elsewhere, but the frontend no longer calls it.

---

## Phase 2: Responsive layout and lot selection shortcuts (US-030)

### 7. Full-width desktop layout

**Before:** `voter-content` had `max-width: 660px`, limiting the two-column voting layout on wide screens.

**After:** `voter-content` has `max-width: 1280px` with `padding: 36px 24px 80px` on desktop and `padding: 20px 16px 60px` on mobile (≤640px).

**Files changed:**
- `src/styles/index.css` — updated `.voter-content` max-width and padding; added mobile media query

### 8. Collapsible lot sidebar on mobile

**Before:** On mobile the sidebar stacked above the motions, always fully expanded.

**After:** On mobile (≤640px) the lot sidebar shows a toggle button with summary text `"Your Lots (N selected) ▾"`. Default state is collapsed. Clicking expands/collapses. On desktop the toggle is `display: none` and the list is always visible.

Implementation:
- `isSidebarExpanded` state (starts `false`)
- Toggle button uses `aria-expanded` attribute
- The list container gets class `voting-layout__sidebar-list--collapsed` when `!isSidebarExpanded`; CSS hides it on mobile via `.voting-layout__sidebar-list--collapsed { display: none; }` scoped inside the `@media (max-width: 640px)` block
- The `@media (min-width: 641px)` block overrides: `display: block !important`

**Files changed:**
- `src/pages/vote/VotingPage.tsx` — added `isSidebarExpanded` state, toggle button JSX, `selectedCount` derived value, `sidebarSummaryLabel`
- `src/styles/index.css` — added `.voting-layout__sidebar-toggle`, `.voting-layout__sidebar-list--collapsed` CSS

### 9. Lot selection shortcut buttons

**Before:** No shortcut buttons in the lot sidebar.

**After:** Four compact secondary buttons above the lot list for multi-lot voters:
- **Select All** — selects all pending lots, clears no-selection error
- **Deselect All** — unchecks all lots
- **Select Proxy Lots** — only rendered when `hasProxyLot`; selects only pending proxy lots, clears no-selection error
- **Select Owned Lots** — only rendered when `hasProxyLot`; selects only pending non-proxy lots, clears no-selection error

Already-submitted lots are always excluded from shortcut selections (their `disabled` checkbox state is preserved).

`hasProxyLot = allLots.some((l) => l.is_proxy)` — controls whether proxy/owned buttons render.

**Files changed:**
- `src/pages/vote/VotingPage.tsx` — added `handleSelectAll`, `handleDeselectAll`, `handleSelectProxy`, `handleSelectOwned`, `hasProxyLot`; added shortcut button JSX inside sidebar
- `src/styles/index.css` — added `.lot-shortcut-buttons` flex container and compact button sizing

### 10. Basic responsive improvements for admin pages

**After:** Mobile improvements to admin pages (no changes to functionality):
- `.admin-main` uses `padding: 16px` on mobile
- `.admin-page-header` stacks vertically (`flex-direction: column`) on mobile
- `.admin-table-wrapper` class provides `overflow-x: auto` for table containers to prevent horizontal scroll

**Files changed:**
- `src/styles/index.css` — added `@media (max-width: 640px)` block for `.admin-main`, `.admin-page-header`, `.field__input`, `.field__select`; added `.admin-table-wrapper`

### Testing additions (Phase 2)

14 new unit tests added to `VotingPage.test.tsx`:
- `Select All button selects all pending lots`
- `Select All clears the no-selection error`
- `Deselect All button unchecks all lots`
- `Select Proxy Lots button only shown when there is a proxy lot and selects only proxy lots`
- `Select Proxy Lots clears the no-selection error`
- `Select Owned Lots button only shown when there is a proxy lot and selects only owned lots`
- `Select Owned Lots clears the no-selection error`
- `Select Proxy/Owned Lots buttons NOT shown when there are no proxy lots`
- `Select Proxy Lots ignores already-submitted lots`
- `Select Owned Lots ignores already-submitted lots`
- `sidebar toggle button renders in multi-lot view`
- `sidebar toggle expands and collapses the list`
- `sidebar toggle summary shows selected count`
- `sidebar toggle summary says 'all submitted' when all lots are submitted`
