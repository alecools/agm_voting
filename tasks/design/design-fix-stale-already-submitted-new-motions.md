# Design: Fix Stale `already_submitted` When Admin Reveals New Motions

**PRD story:** US-FIX-NM01 (follow-up: BUG-NM-01-B)
**Schema migration needed:** No

---

## Overview

When all of a voter's lots have submitted ballots for every currently-visible motion, each lot is marked `already_submitted: true` and its checkbox is disabled in `VotingPage`. If an admin then makes an additional motion visible, those lots should automatically unlock — they have not yet voted on the new motion. The original BUG-NM-01 fix attempted to detect this by tracking motions count with a `prevMotionCountRef` and calling `restoreSession` when the count increased. That fix has a re-mount bug (BUG-NM-01-B) described below.

---

## Root Cause

### Server-side (correct, unchanged)

`POST /api/auth/verify` and `POST /api/auth/session` both compute `already_submitted` dynamically at the time of the call:

```python
already_submitted = (
    len(visible_motion_ids) > 0
    and visible_motion_ids.issubset(voted_for_this_lot)
)
```

The server is correct and needs no changes.

### Original BUG-NM-01 root cause (still present)

`VotingPage.tsx` lines 50-62 loads `allLots` from sessionStorage on mount, initialising `already_submitted` from a cached value that was written when the voter last submitted. After that, `already_submitted` is only updated in `submitMutation.onSuccess` (setting it to `true`). No code path sets it back to `false` when new motions appear.

### BUG-NM-01-B: re-mount failure in the original fix

The original fix introduced a `prevMotionCountRef` (starting at `-1` as a sentinel) and a `useEffect([motions, meetingId])`. The logic was:

```
if prevMotionCountRef === -1:   // first load — set baseline, do NOT call restoreSession
    prevMotionCount = motions.length
    return
if motions.length > prevMotionCount:  // motions grew — call restoreSession
    ...
```

This breaks when:

1. Voter votes batch 1, submits → `already_submitted: true` written to sessionStorage.
2. Admin reveals batch 2 → motions count grows → `restoreSession` is called → lots unlock. Works.
3. Voter votes batch 2, submits → `already_submitted: true` again in sessionStorage.
4. Voter navigates to confirmation page → `VotingPage` unmounts → `prevMotionCountRef` is destroyed.
5. Admin reveals batch 3.
6. Voter returns to `VotingPage` → component **re-mounts** → `prevMotionCountRef` resets to `-1`.
7. The effect fires with `prevMotionCountRef === -1` → treats this as "first load, set baseline" → does NOT call `restoreSession` → lots remain locked with stale `already_submitted: true`.

The sentinel exists to avoid a spurious `restoreSession` call on the very first mount (when the voter has just authenticated and sessionStorage is fresh). But it also suppresses the necessary call on every subsequent re-mount.

### Why Option C is now the right fix

At the time the original design doc was written, `voted_motion_ids` did not exist on `LotInfo`. That doc explicitly noted: "There is no `voted_motion_ids` field. The fix therefore cannot be implemented by deriving `already_submitted` from `lot.voted_motion_ids`."

**This is no longer true.** As of the current codebase:

- `frontend/src/api/voter.ts` line 38: `voted_motion_ids: string[]` exists on `LotInfo`.
- `VotingPage.tsx` lines 273-275: `isMotionReadOnly` already computes read-only state from `voted_motion_ids`:
  ```tsx
  const isMotionReadOnly = (m: { id: string }) =>
    readOnlyReferenceLots.length > 0 &&
    readOnlyReferenceLots.every((lot) => (lot.voted_motion_ids ?? []).includes(m.id));
  ```

`voted_motion_ids` is a per-lot list of motion IDs for which that lot has a submitted ballot. It is returned by `POST /api/auth/session` (and `POST /api/auth/verify`) as part of `LotInfo`, and is written to sessionStorage alongside `already_submitted`.

This means `already_submitted` can be computed dynamically in the render:

```
isLotSubmitted(lot) = motions.length > 0 && motions.every(m => lot.voted_motion_ids.includes(m.id))
```

A lot is effectively submitted when every currently-visible motion is in its `voted_motion_ids` set. This is exactly what the server computes — but now the frontend can do it locally from data it already has, with no extra API call.

---

## Chosen Fix: Option C — Derive `already_submitted` dynamically from `voted_motion_ids`

### What changes

In `VotingPage.tsx`, replace all reads of `lot.already_submitted` with a derived value computed from `lot.voted_motion_ids` and the current `motions` array. The `voted_motion_ids` field is already in sessionStorage and in `allLots` state — it is kept up to date by `submitMutation.onSuccess` (which must also update `voted_motion_ids` in addition to `already_submitted`).

Remove the `prevMotionCountRef` and the motion-count-tracking `useEffect` introduced by the original BUG-NM-01 fix. They are no longer needed.

### Derived value

```tsx
const isLotSubmitted = (lot: LotInfo): boolean => {
  if (!motions || motions.length === 0) return false;
  return motions.every((m) => (lot.voted_motion_ids ?? []).includes(m.id));
};
```

This function is called at render time. Because `motions` is live React Query state, it automatically reflects new motions the moment the motions query re-fetches — no manual effect required.

### Impact on existing reads of `already_submitted`

Every place in `VotingPage.tsx` that reads `lot.already_submitted` must be replaced with `isLotSubmitted(lot)`:

| Location | Current | Replacement |
|---|---|---|
| Line 57: `lots.filter((l) => !l.already_submitted)` in mount useEffect | reads from sessionStorage snapshot | replace with `isLotSubmitted` after motions load, OR keep the sessionStorage-based initial selection and rely on the derived value for rendering |
| Line 207: `allLots.every((l) => l.already_submitted)` for `allSubmitted` | derived bool | `allLots.every((l) => isLotSubmitted(l))` |
| Line 208: `allLots.filter((l) => !l.already_submitted)` for `pendingLots` | derived bool | `allLots.filter((l) => !isLotSubmitted(l))` |
| Line 236: `allLots.filter((l) => !l.already_submitted)` in `handleSelectAll` | derived bool | `allLots.filter((l) => !isLotSubmitted(l))` |
| Line 246: `l.is_proxy && !l.already_submitted` in `handleSelectProxy` | derived bool | `l.is_proxy && !isLotSubmitted(l)` |
| Line 252: `!l.is_proxy && !l.already_submitted` in `handleSelectOwned` | derived bool | `!l.is_proxy && !isLotSubmitted(l)` |
| Line 272: `readOnlyReferenceLots` falls back to `allLots` when `selectedLots` empty | `selectedLots.length > 0` — `selectedLots` is filtered by `selectedIds`, which itself is seeded from `!already_submitted` | indirectly affected; once `isLotSubmitted` returns false, these lots re-enter `selectedIds` correctly |
| Lines 400-431 (JSX): `lot.already_submitted` for badge and checkbox disabled state | render | `isLotSubmitted(lot)` |
| Lines 540-565 (JSX): single-lot inline panel `allLots[0].already_submitted` | render | `isLotSubmitted(allLots[0])` |

### Mount `useEffect` — initial `selectedIds` seeding

The mount useEffect (lines 50-62) seeds `selectedIds` from `!l.already_submitted`. At mount time, `motions` is not yet loaded (async React Query fetch). Two options:

**A.** Keep the sessionStorage-based seeding on mount (as today), and add a second `useEffect([motions])` that re-seeds `selectedIds` whenever `motions` loads or changes:

```tsx
useEffect(() => {
  if (!motions || allLots.length === 0) return;
  setSelectedIds((prev) => {
    const next = new Set(prev);
    for (const lot of allLots) {
      if (!isLotSubmitted(lot)) {
        next.add(lot.lot_owner_id);
      } else {
        next.delete(lot.lot_owner_id);
      }
    }
    return next;
  });
}, [motions, allLots]);
```

This means: once motions are known, correct `selectedIds` to reflect true unlock status.

**B.** Remove the sessionStorage-based initial seeding entirely, and seed `selectedIds` only when motions are loaded (in the `[motions, allLots]` effect above). This is simpler but introduces a brief moment where `selectedIds` is empty before motions load.

**Decision: Option A** — keep the sessionStorage-based initial selection for a fast first render, then correct it once motions load. This avoids a visible flicker where all checkboxes appear unchecked.

### `submitMutation.onSuccess` — update `voted_motion_ids`

The `onSuccess` handler currently updates `already_submitted: true` for submitted lots in both state and sessionStorage. Under the new approach, `already_submitted` is derived and the field on `LotInfo` in state/sessionStorage is no longer authoritative. However, `voted_motion_ids` must remain accurate.

The `onSuccess` handler must add the current motion IDs to `voted_motion_ids` for each submitted lot:

```tsx
const currentMotionIds = motions ? motions.map((m) => m.id) : [];

const updatedLots = currentLots.map((lot) =>
  submittedSet.has(lot.lot_owner_id)
    ? {
        ...lot,
        already_submitted: true,  // keep for backward compat with any other readers
        voted_motion_ids: Array.from(
          new Set([...(lot.voted_motion_ids ?? []), ...currentMotionIds])
        ),
      }
    : lot
);
```

This ensures that after submission, `isLotSubmitted(lot)` still returns `true` for submitted lots — and when new motions appear, they are not in `voted_motion_ids`, so `isLotSubmitted` returns `false` automatically.

### Removal of `prevMotionCountRef` and motion-count useEffect

Once `already_submitted` is derived dynamically, the `prevMotionCountRef` ref and the `useEffect` that watches `motions.length` are no longer needed. Remove both.

---

## Data Flow (Happy Path — batch voting scenario)

1. Voter authenticates. `LotInfo.voted_motion_ids = []` for all lots. Motions: [M1].
2. `isLotSubmitted(lot)` = `false` (M1 not in voted_motion_ids). Lots appear unlocked.
3. Voter votes on M1, submits. `onSuccess` adds M1 to `voted_motion_ids` for submitted lots. SessionStorage updated. Voter navigates to confirmation.
4. Admin reveals M2.
5. Voter returns to VotingPage. Re-mounts. Mount useEffect reads sessionStorage — `voted_motion_ids = [M1]`, `already_submitted: true` (stale boolean, ignored for rendering).
6. React Query fetches motions → returns [M1, M2]. The `[motions, allLots]` useEffect fires and recomputes `selectedIds`:
   - `isLotSubmitted(lot)` = `motions.every(m => [M1].includes(m.id))` = false (M2 not in voted_motion_ids).
   - Lots are added to `selectedIds`.
7. UI re-renders: lots are unlocked (no "Already submitted" badge, checkbox enabled). M1 shows prior choice pre-filled (read-only via `isMotionReadOnly` which checks voted_motion_ids). M2 is interactive.
8. Voter votes on M2, submits. `onSuccess` adds M2 to `voted_motion_ids`. Now `voted_motion_ids = [M1, M2]`.
9. Admin reveals M3. Voter returns. Step 5-8 repeats correctly for any number of batches, regardless of how many times the component remounts.

---

## Frontend Changes

### `VotingPage.tsx`

1. Add `isLotSubmitted(lot: LotInfo): boolean` helper (inline or as a `useCallback`).
2. Replace all reads of `lot.already_submitted` in render and derived values with `isLotSubmitted(lot)`.
3. Add a `useEffect([motions, allLots])` that re-seeds `selectedIds` whenever motions or lots change, replacing stale `selectedIds` entries.
4. Update `submitMutation.onSuccess` to merge current motion IDs into `voted_motion_ids` for submitted lots (in both React state and sessionStorage).
5. Remove `prevMotionCountRef` and the motion-count-tracking `useEffect` if present.

### `frontend/src/api/voter.ts`

No changes needed. `LotInfo.voted_motion_ids` already exists.

### Backend

No changes needed.

---

## Key Design Decisions

**Why Option C over Option A (always call restoreSession on mount)?**
Option A adds an API call on every VotingPage mount — including the common case where nothing has changed. Option C derives the value from data already in memory with no network round-trip. It is also more robust: the unlock happens the moment React Query returns updated motions, with no dependency on localStorage or session token availability.

**Why Option C over Option B (restoreSession on mount only if stale lots exist)?**
Option B is a heuristic: "if any lot is marked already_submitted, maybe it's stale." It adds an API call on every return-to-voting after a submission, which covers the bug but wastes a round-trip. Option C has no false positives and no extra calls.

**Why keep `already_submitted` in the sessionStorage LotInfo objects?**
For backward compatibility with any other code that reads the sessionStorage shape (e.g. AuthPage, ConfirmationPage). It is not the authoritative source for lock state in `VotingPage` under the new design, but keeping it written avoids breaking any reader that still checks it.

**Why a separate `[motions, allLots]` useEffect for re-seeding `selectedIds`?**
The mount useEffect (loads from sessionStorage) runs before motions are available. A second effect that fires when motions change is the idiomatic React pattern for a derived state that depends on async data.

---

## Vertical Slice

This fix is entirely frontend-only. No backend changes, no schema migrations, no new API endpoints. It can be implemented and tested independently of all other open stories.

---

## E2E Test Scenarios

### Happy path: new motion unlocks previously-submitted lots (single session, no remount)

1. Seed: one open meeting with 1 visible motion (M1), voter with 2 lots.
2. Voter authenticates, votes on M1 for both lots, submits. Both lots show "Already submitted".
3. Admin (via API) makes M2 visible on the same meeting.
4. In the same voter session, navigate back to VotingPage (e.g. back button or direct URL).
5. Assert: both lots no longer show "Already submitted" badge; both checkboxes are enabled.
6. Assert: M1 is shown with the previously-submitted choice pre-filled and is read-only (voted_motion_ids includes M1).
7. Assert: M2 is shown as interactive with no prior choice.
8. Assert: "Submit ballot" button is visible.
9. Voter votes on M2 for both lots and submits. Navigate to confirmation. Assert both lots appear in the confirmation summary.

### BUG-NM-01-B regression: unlock works after component remount (multiple batches)

1. Seed: one open meeting with 1 visible motion (M1), voter with 1 lot.
2. Voter authenticates, votes M1, submits. Navigated to confirmation (VotingPage unmounts).
3. Admin reveals M2.
4. Voter clicks "View my votes" or back-navigates to VotingPage (component re-mounts fresh).
5. Assert: lot is unlocked (no "Already submitted" badge, checkbox enabled).
6. Voter votes M2, submits. Navigated to confirmation (VotingPage unmounts again).
7. Admin reveals M3.
8. Voter returns to VotingPage again (third mount).
9. Assert: lot is unlocked again. M1 and M2 are read-only with prior choices. M3 is interactive.

### Edge case: single-lot voter

1. Seed: one open meeting with 1 visible motion, voter with 1 lot.
2. Voter authenticates, votes on M1, submits. Voter navigated to confirmation.
3. Admin makes M2 visible.
4. Voter navigates back to VotingPage.
5. Assert: lot is not marked "Already submitted"; M1 shows prior choice as read-only; M2 is interactive.

### Edge case: partial submission (some lots submitted, some not)

1. Seed: one open meeting with 1 visible motion, voter with 3 lots. Lots A and B submitted on M1, Lot C not.
2. Admin makes M2 visible.
3. Voter navigates to VotingPage.
4. Assert: Lots A and B are unlocked; Lot C was never submitted, also unlocked.
5. Assert: all three lots are in selectedIds (all checkboxes checked).

### No regression: fully unvoted lots stay unlocked when motions load

1. Seed: one open meeting, voter with 1 lot, 2 visible motions. Voter has NOT yet voted.
2. VotingPage mounts and fetches motions. No lots should be locked.
3. Assert: lot is unlocked, both motions are interactive.
4. Voter votes and submits normally. Confirm submission succeeds.

### No regression: session token absent does not break the page

1. Manually remove `agm_session_${meetingId}` from localStorage.
2. Navigate to VotingPage with an existing sessionStorage cache.
3. Assert: no unhandled error; page renders motions normally.
4. (No restoreSession is called under Option C — this scenario simply confirms Option A's risk is eliminated.)
