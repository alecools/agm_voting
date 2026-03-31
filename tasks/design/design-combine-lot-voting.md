# Design: Combine LotSelectionPage into VotingPage

**Status:** Implemented

## Summary

Eliminate the standalone `LotSelectionPage` route. After successful authentication, the voter lands directly on `VotingPage`. For multi-lot voters (or any voter with a proxied lot), the top of `VotingPage` shows a lot-selection section (checkboxes + badges) before the motion cards. For single-lot non-proxy voters, the lot-selection section is skipped entirely and motions are shown immediately.

No backend changes required. This is a pure frontend refactor.

---

## Current Flow

```
Auth page → /vote/:id/lot-selection (LotSelectionPage) → /vote/:id/voting (VotingPage)
```

`AuthPage.onSuccess` writes four sessionStorage keys and then navigates:
- `meeting_lots_${meetingId}` — array of pending lot_owner_ids (used by submit)
- `meeting_lots_info_${meetingId}` — full `LotInfo[]` (used by LotSelectionPage)
- `meeting_lot_info_${meetingId}` — pending `LotInfo[]` (used by VotingPage for in-arrear detection)
- `meeting_building_name_${meetingId}` / `meeting_title_${meetingId}` — header context

`LotSelectionPage` reads `meeting_lots_info_${meetingId}`, displays the lot list, and on "Start Voting" writes the selected IDs to `meeting_lots_${meetingId}` before navigating to `/voting`.

`VotingPage` reads `meeting_lots_${meetingId}` (for submission) and `meeting_lot_info_${meetingId}` (for in-arrear logic). Its back button points to `/lot-selection`.

---

## Target Flow

```
Auth page → /vote/:id/voting (VotingPage, with optional lot-selection section at top)
```

- `AuthPage` navigates directly to `/vote/:id/voting` (for open AGMs with pending lots).
- `VotingPage` reads `meeting_lots_info_${meetingId}` itself and renders a lot-selection section at the top when needed.
- `LotSelectionPage` is deleted.
- The `/vote/:id/lot-selection` route is removed from `App.tsx`.

---

## Detailed Changes

### 1. `frontend/src/pages/vote/AuthPage.tsx`

Change one line in `onSuccess`:

```
// Before:
navigate(`/vote/${meetingId}/lot-selection`);

// After:
navigate(`/vote/${meetingId}/voting`);
```

The four `sessionStorage.setItem` calls are unchanged. The `meeting_lots_${meetingId}` key is still written by AuthPage with all pending lot IDs (the default when no explicit selection has been made).

### 2. `frontend/src/pages/vote/VotingPage.tsx`

Add a lot-selection section at the top of the page, rendered conditionally.

#### New state

```ts
// Full lot list from sessionStorage (same key LotSelectionPage used)
const [allLots, setAllLots] = useState<LotInfo[]>([]);

// IDs the voter has chosen to vote for; initialised to all pending lot IDs
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

// Whether the lot-selection UI has been confirmed and hidden
const [lotsConfirmed, setLotsConfirmed] = useState(false);

// Validation error shown when "Start Voting" clicked with nothing selected
const [showNoSelectionError, setShowNoSelectionError] = useState(false);
```

#### Derived values (computed from allLots)

```ts
const isMultiLotOrProxy = allLots.length > 1 || allLots.some((l) => l.is_proxy);
const allSubmitted = allLots.length > 0 && allLots.every((l) => l.already_submitted);
const pendingLots = allLots.filter((l) => !l.already_submitted);
```

#### Single-lot auto-skip rule

If `allLots.length === 1 && !allLots[0].is_proxy`, skip the lot-selection UI entirely:
- `lotsConfirmed` can start as `true` (or never be set to false for single-lot non-proxy voters).
- No checkboxes are rendered; motions are immediately visible.

Practically: initialise `lotsConfirmed` based on whether lot-selection UI is needed:
```ts
const [lotsConfirmed, setLotsConfirmed] = useState(() => {
  // auto-confirm for single non-proxy lots
  const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
  if (!raw) return true;
  try {
    const lots = JSON.parse(raw) as LotInfo[];
    return lots.length <= 1 && !lots.some((l) => l.is_proxy);
  } catch { return true; }
});
```

#### Lot-selection UI (rendered when `!lotsConfirmed && !allSubmitted`)

Positioned before the progress bar and motion cards. Structure mirrors `LotSelectionPage` but is a section within the page, not a full page:

```tsx
{!lotsConfirmed && !allSubmitted && (
  <div className="lot-selection">
    <h2 className="lot-selection__title">Your Lots</h2>
    <p className="lot-selection__subtitle">
      {isMultiLot
        ? `You are voting for ${selectedIds.size} lot${selectedIds.size !== 1 ? "s" : ""}.`
        : `You are voting for ${pendingLots.length} lot${pendingLots.length !== 1 ? "s" : ""}.`}
    </p>
    <ul className="lot-selection__list" role="list">
      {allLots.map((lot) => (
        <li key={lot.lot_owner_id} className={...} aria-disabled={...}>
          {isMultiLot && <input type="checkbox" ... />}
          <span className="lot-selection__lot-number">Lot {lot.lot_number}</span>
          {lot.is_proxy && (
            <span className="lot-selection__badge lot-selection__badge--proxy">
              Lot {lot.lot_number} via Proxy
            </span>
          )}
          {lot.financial_position === "in_arrear" && (
            <span className="lot-selection__badge lot-selection__badge--arrear">In Arrear</span>
          )}
          {lot.already_submitted && (
            <span className="lot-selection__badge lot-selection__badge--submitted">Already submitted</span>
          )}
        </li>
      ))}
    </ul>
    {showNoSelectionError && <p role="alert">Please select at least one lot</p>}
    <button type="button" className="btn btn--primary" onClick={handleStartVoting}>
      Start Voting
    </button>
  </div>
)}
```

Note: The proxy badge label changes from "Proxy for Lot X" (current LotSelectionPage) to "Lot X via Proxy" as requested.

#### `handleStartVoting`

```ts
const handleStartVoting = () => {
  if (isMultiLot && selectedIds.size === 0) {
    setShowNoSelectionError(true);
    return;
  }
  if (isMultiLot) {
    sessionStorage.setItem(`meeting_lots_${meetingId}`, JSON.stringify([...selectedIds]));
  }
  setLotsConfirmed(true);
};
```

#### All-submitted case

When `allSubmitted === true` AND `lotsConfirmed === false`, render a "View Submission" button (same logic as LotSelectionPage) that navigates to `/vote/${meetingId}/confirmation`. This handles the edge case where a voter navigates directly to `/voting` after having already voted.

#### Back button

Change the back button from `/vote/${meetingId}/lot-selection` to `/vote/${meetingId}` (auth page):

```tsx
// Before:
onClick={() => navigate(`/vote/${meetingId}/lot-selection`)}

// After:
onClick={() => navigate(`/vote/${meetingId}`)}
```

When `lotsConfirmed === true` and `isMultiLotOrProxy === true`, a secondary "Back" action within the lot-confirmed view could return the voter to the lot-selection section by setting `lotsConfirmed = false`. However, to keep the implementation simple, the back button on VotingPage navigates to auth — consistent with returning to the start of the voter journey. This is the correct UX since the lot-selection section is now part of VotingPage, not a separate page.

#### `useEffect` for loading allLots

```ts
useEffect(() => {
  if (!meetingId) return;
  const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
  if (!raw) return;
  try {
    const lots = JSON.parse(raw) as LotInfo[];
    setAllLots(lots);
    // Initialise selectedIds to all pending lot IDs
    const pending = lots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
    setSelectedIds(new Set(pending));
  } catch { /* ignore */ }
}, [meetingId]);
```

### 3. `frontend/src/styles/index.css`

Add CSS for `.lot-selection__*` BEM classes. These classes are already used in `LotSelectionPage.tsx` but are not defined in `index.css` (they were not defined anywhere in the checked-in CSS). They need to be added now since `LotSelectionPage.tsx` will be deleted.

The styles should be consistent with the existing design system tokens:
- `.lot-selection` — section container, `margin-bottom: 32px`, `padding-bottom: 24px`, `border-bottom: 1px solid var(--border)`
- `.lot-selection__title` — `font-family: 'Cormorant Garamond', serif`, `font-size: 1.5rem`
- `.lot-selection__subtitle` — `color: var(--text-secondary)`, `font-size: 0.9rem`, `margin-bottom: 14px`
- `.lot-selection__list` — `list-style: none`, `padding: 0`, `margin-bottom: 16px`
- `.lot-selection__item` — `display: flex`, `align-items: center`, `gap: 10px`, `padding: 10px 0`, `border-bottom: 1px solid var(--border-subtle)`
- `.lot-selection__item--submitted` — `opacity: 0.5`
- `.lot-selection__lot-number` — `font-weight: 600`, `font-size: 0.9375rem`
- `.lot-selection__checkbox` — `flex-shrink: 0`, `width: 16px`, `height: 16px`, `accent-color: var(--navy)`
- `.lot-selection__badge` — base pill style: `font-size: 0.65rem`, `font-weight: 700`, `letter-spacing: 0.06em`, `padding: 2px 8px`, `border-radius: 999px`, `text-transform: uppercase`
- `.lot-selection__badge--proxy` — `background: var(--navy)`, `color: var(--gold-light)`
- `.lot-selection__badge--arrear` — `background: var(--amber-bg)`, `color: var(--amber)`
- `.lot-selection__badge--submitted` — `background: #F0EFEE`, `color: var(--text-muted)`

### 4. `frontend/src/App.tsx`

Remove the `/vote/:meetingId/lot-selection` route and the import of `LotSelectionPage`:

```tsx
// Remove:
import { LotSelectionPage } from "./pages/vote/LotSelectionPage";
// Remove:
<Route path="/vote/:meetingId/lot-selection" element={<LotSelectionPage />} />
```

### 5. `frontend/src/pages/vote/LotSelectionPage.tsx`

**Delete this file.** All its logic moves into VotingPage.

---

## Vertical Slices

This is a small, fully frontend change with no DB or backend involvement. It fits naturally in a single slice since all four file changes are tightly coupled (removing a route requires updating the navigation in AuthPage and VotingPage simultaneously; CSS is required for the lot-selection UI in VotingPage to render correctly).

**One slice, one branch.**

---

## State Management Notes

### sessionStorage keys — no change to format

| Key | Written by | Read by (after) |
|---|---|---|
| `meeting_lots_${id}` | AuthPage (all pending IDs); VotingPage (selected subset, multi-lot only) | VotingPage `submitMutation` |
| `meeting_lots_info_${id}` | AuthPage | VotingPage (new: for lot-selection section) |
| `meeting_lot_info_${id}` | AuthPage | VotingPage (existing: in-arrear detection) |
| `meeting_building_name_${id}` / `meeting_title_${id}` | AuthPage | VotingPage (existing: agm-header) — these are already available, no change needed |

The meeting title and building name are already shown in the `agm-header` section of VotingPage via the `fetchBuildings` + `fetchGeneralMeetings` queries. The lot-selection section does not need to re-display them — the agm-header already provides that context above the lot-selection section.

### Initialization order

`allLots` is loaded from sessionStorage in a `useEffect`. The `lotsConfirmed` initial state is computed in a `useState` initialiser function that reads sessionStorage synchronously — this is safe since sessionStorage reads are synchronous.

### Multi-lot selectedIds

For multi-lot voters, `selectedIds` defaults to all pending lot IDs. The voter can uncheck lots before clicking "Start Voting". On confirm, the selected IDs overwrite `meeting_lots_${meetingId}` in sessionStorage, which is what `submitMutation` reads.

For single-lot voters, `selectedIds` is never written to sessionStorage by VotingPage — AuthPage already set `meeting_lots_${meetingId}` to the single pending lot ID.

---

## Tests to Update / Add

### Files to delete

- `/Users/stevensun/personal/agm_survey/frontend/src/pages/vote/__tests__/LotSelectionPage.test.tsx` — delete entirely (LotSelectionPage no longer exists)

### Files to update

**`/Users/stevensun/personal/agm_survey/frontend/src/pages/vote/__tests__/VotingPage.test.tsx`**

Add new test cases for the lot-selection section:

- Single-lot non-proxy: lot-selection section is not rendered; motions are immediately visible
- Single-lot proxy: lot-selection section IS rendered; shows "Lot X via Proxy" badge; clicking "Start Voting" reveals motions
- Multi-lot: lot-selection section shown with checkboxes; all pending lots checked by default; subtitle shows count; "Start Voting" shows motions
- Multi-lot: unchecking a lot updates subtitle count
- Multi-lot: clicking "Start Voting" with no lots selected shows validation alert
- Multi-lot: clicking "Start Voting" writes selected IDs to sessionStorage and reveals motions
- All-submitted state: shows "View Submission" button instead of "Start Voting"; clicking it navigates to confirmation
- Back button navigates to `/vote/${meetingId}` (auth page), not lot-selection

Update existing tests:
- "back button navigates to lot-selection page" → change expected URL to `/vote/${AGM_ID}` (the auth route)

**`/Users/stevensun/personal/agm_survey/frontend/src/pages/vote/__tests__/VotingFlow.integration.test.tsx`**

Update or remove:
- "lot-selection page renders after navigating to /vote/:meetingId/lot-selection" — remove this test (route no longer exists)
- "full submit flow" — no navigation change needed (it starts directly at `/voting`)

**`/Users/stevensun/personal/agm_survey/frontend/src/pages/vote/__tests__/AuthPage.test.tsx`**

Update the assertion for where auth navigates on success:
- Current: expects navigate to `/vote/${meetingId}/lot-selection`
- New: expects navigate to `/vote/${meetingId}/voting`

### E2E specs to update

**`/Users/stevensun/personal/agm_survey/frontend/e2e/voting-flow.spec.ts`**

The main journey test currently checks for `/(lot-selection|confirmation)` after auth, then clicks "Start Voting" if on lot-selection. Update to:
- After auth, expect URL to match `/(voting|confirmation)` directly
- Remove the `if (page.url().includes("/lot-selection"))` branch
- For single-lot voter (E2E-1), motions should be immediately visible on `/voting`
- The `failed authentication` test similarly expects `/(voting|confirmation)` on success

**`/Users/stevensun/personal/agm_survey/frontend/e2e/multi-lot-voting.spec.ts`**

Multi-lot tests currently navigate to `/lot-selection` after auth and interact with `.lot-selection__item` locators and "Start Voting" button there. Update to:
- Expect URL to match `/voting` after auth (not `/lot-selection`)
- Assert lot-selection section is visible at the top of the voting page
  - `await expect(page.getByText("You are voting for 2 lots.")).toBeVisible()` — still valid
  - `.lot-selection__item` locators — still valid (same CSS class names reused in VotingPage)
  - Checkbox `Select Lot ${LOT_NUMBER_2}` — still valid (same aria-label)
  - "Start Voting" button — still present; clicking it reveals the motions
- After "Start Voting", motions appear on the **same page** (not a navigation); assert motions are visible below
- Scenario 4 test navigates directly to `/vote/${meetingId}/lot-selection` — change to `/vote/${meetingId}/voting`
  - The "lot-selection" assertions still apply since the lot-selection section is at the top of VotingPage
  - `.lot-selection__item--submitted` locators still valid

**`/Users/stevensun/personal/agm_survey/frontend/e2e/proxy-voting.spec.ts`**

Proxy tests currently check `/(lot-selection|confirmation)` after auth. Update to:
- Expect `/(voting|confirmation)` after auth
- When on `/voting`, the lot-selection section is shown at top (since proxy voter always triggers the section)
- `.lot-selection__item` and `.lot-selection__badge--proxy` locators — still valid (same class names)
- "Start Voting" button — still valid; clicking it reveals motions on the same page
- The proxy badge text changes from `"Proxy for Lot X"` to `"Lot X via Proxy"` — update all `toContainText("Proxy")` or `toContainText("Proxy for Lot")` assertions to match new label

**`/Users/stevensun/personal/agm_survey/frontend/e2e/in-arrear-voting.spec.ts`** (review)

Check if this spec navigates via lot-selection — if so, update to expect `/voting` directly.

---

## Breaking Changes / Risks

### Risk 1: Proxy badge text change

The existing `LotSelectionPage` shows "Proxy for Lot X". The requested label is "Lot X via Proxy". This affects:
- `proxy-voting.spec.ts` — badge text assertions must be updated
- `LotSelectionPage.test.tsx` — deleted, no action needed
- Any user-facing documentation

### Risk 2: LotSelectionPage route still accessible by URL

After the route is removed, direct navigation to `/vote/:id/lot-selection` will hit a React Router no-match (blank or 404). Any bookmarked or hardcoded URLs to `/lot-selection` will break. This is acceptable since the route is internal to the app flow and not user-bookmarkable in practice. If a catch-all redirect is needed, a `<Route path="*" element={<Navigate to="/" />} />` can be added to App.tsx, but this is likely already handled or not needed.

### Risk 3: `lotsConfirmed` state initialization from sessionStorage

If sessionStorage is empty (e.g., voter navigates directly to `/voting` without going through auth), `allLots` will be empty and `lotsConfirmed` will be `true` — so the page renders motions directly, same as today. This is safe.

### Risk 4: Back button destination change

The back button on VotingPage previously went to `/lot-selection`. It now goes to `/vote/${meetingId}` (auth page). For multi-lot voters mid-session, they cannot return to the lot-selection section via the back button — they must re-authenticate. This is an acceptable UX trade-off. If the product owner wants a "Back to lot selection" button within VotingPage (to re-select lots without re-authing), that can be a follow-up: a separate button that sets `lotsConfirmed = false`, visible only when `isMultiLotOrProxy && lotsConfirmed`.

### Risk 5: E2E tests using `/lot-selection` URL directly

`multi-lot-voting.spec.ts` Scenario 4 navigates directly to `/vote/${meetingId}/lot-selection`. This must change to `/vote/${meetingId}/voting`. The assertions that follow (checking `.lot-selection__item--submitted`, subtitle text, "View Submission" button) remain valid since those elements are now part of VotingPage.

---

## Files Modified Summary

| File | Action |
|---|---|
| `frontend/src/pages/vote/AuthPage.tsx` | Change navigation target from `/lot-selection` to `/voting` |
| `frontend/src/pages/vote/VotingPage.tsx` | Add lot-selection section at top; update back button; add state for lot selection |
| `frontend/src/styles/index.css` | Add `.lot-selection__*` CSS classes |
| `frontend/src/App.tsx` | Remove `LotSelectionPage` import and route |
| `frontend/src/pages/vote/LotSelectionPage.tsx` | Delete |
| `frontend/src/pages/vote/__tests__/LotSelectionPage.test.tsx` | Delete |
| `frontend/src/pages/vote/__tests__/VotingPage.test.tsx` | Add lot-selection unit tests; update back button test |
| `frontend/src/pages/vote/__tests__/VotingFlow.integration.test.tsx` | Remove lot-selection route test; update auth navigation assertion |
| `frontend/src/pages/vote/__tests__/AuthPage.test.tsx` | Update expected navigate target |
| `frontend/e2e/voting-flow.spec.ts` | Update post-auth URL assertion; remove lot-selection branch |
| `frontend/e2e/multi-lot-voting.spec.ts` | Update post-auth URL; update direct lot-selection URL navigation; proxy badge text if applicable |
| `frontend/e2e/proxy-voting.spec.ts` | Update post-auth URL; update proxy badge text assertion |
| `frontend/e2e/in-arrear-voting.spec.ts` | Review and update if it navigates via lot-selection |
