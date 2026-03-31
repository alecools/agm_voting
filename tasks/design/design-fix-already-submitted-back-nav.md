# Design: Fix — Already-Submitted State Lost on Return from Confirmation Page

**Status:** Implemented

## Overview

After a voter submits their ballot and clicks "View my votes" on the `ConfirmationPage`, they are navigated back to `/vote/:meetingId/voting`. On re-mount, `VotingPage` incorrectly renders all lots as not yet submitted (no "Already submitted" badge, checkboxes enabled) and all motions as interactive rather than read-only. This document diagnoses the exact root cause and specifies the minimal fix.

---

## Root Cause Analysis

### Symptom 1: Lots do not show "Already submitted" badge

The lot submission state in `VotingPage` is derived from two sources:

1. **React state (`allLots`)** — populated on mount from `meeting_lots_info_<meetingId>` in sessionStorage.
2. **SessionStorage (`meeting_lots_info_<meetingId>`)** — written by `AuthPage.handleAuthSuccess` on first auth, and supposed to be updated by `VotingPage.submitMutation.onSuccess` after submission.

In `VotingPage.tsx`, `submitMutation.onSuccess` contains the following sequence (lines 145–174):

```tsx
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

  const raw = sessionStorage.getItem(`meeting_lots_${meetingId}`);
  const submittedIds: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  const submittedSet = new Set(submittedIds);

  // sessionStorage.setItem is called INSIDE the setAllLots functional updater:
  setAllLots((prev) => {
    const updated = prev.map((lot) =>
      submittedSet.has(lot.lot_owner_id)
        ? { ...lot, already_submitted: true }
        : lot
    );
    if (meetingId) {
      sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(updated));
    }
    return updated;
  });

  setSelectedIds((prev) => { ... });

  navigate(`/vote/${meetingId}/confirmation`);
},
```

The `sessionStorage.setItem` call is placed **inside** the functional updater passed to `setAllLots`. In React 18's concurrent rendering model, `navigate()` (from React Router v6) internally wraps the navigation in `startTransition`. This causes React to begin rendering `ConfirmationPage` concurrently while `VotingPage` is still nominally mounted. Under certain scheduling conditions, React may unmount `VotingPage` before the functional updater for `setAllLots` has been flushed — meaning the `sessionStorage.setItem` inside that updater is **never executed**.

The result: when the voter navigates from `ConfirmationPage` back to `VotingPage` via "View my votes", the re-mount `useEffect` at lines 48–60 reads `meeting_lots_info_<meetingId>` from sessionStorage and finds the **pre-submission** value, which has `already_submitted: false` for all lots.

### Symptom 2: Motions are not read-only (not locked)

The read-only state of a motion is derived in `VotingPage` as follows (lines 251–253):

```tsx
const hasUnsubmittedSelected = selectedLots.some((l) => !l.already_submitted);
const isMotionReadOnly = (m: { already_voted: boolean }) =>
  m.already_voted && !hasUnsubmittedSelected;
```

`m.already_voted` comes from the `MotionOut` response returned by `useQuery(["motions", meetingId])`. On re-mount, TanStack Query has this query marked as stale (because `invalidateQueries` was called in `onSuccess`). TanStack Query's default behaviour is to **serve the stale cache immediately** while re-fetching in the background. During the brief window between mount and the completion of the background re-fetch, every motion has `already_voted: false` from the stale cache.

Additionally, because Symptom 1 means `allLots` is loaded from pre-submission sessionStorage (all lots have `already_submitted: false`), `hasUnsubmittedSelected` evaluates to `true`, which makes `isMotionReadOnly` return `false` for every motion — even after the fresh server response arrives. So even if the motions query refetch succeeds and returns `already_voted: true`, the `isMotionReadOnly` guard is defeated by the stale lot state.

Both symptoms therefore share the same underlying root cause: **the sessionStorage write for `meeting_lots_info_<meetingId>` is inside a React functional updater that may not execute before the component is unmounted.**

### Summary Table

| Symptom | Root cause | File | Lines |
|---|---|---|---|
| Lots show no "Already submitted" badge | `sessionStorage.setItem` inside `setAllLots` functional updater; may not run before unmount | `VotingPage.tsx` | 155–164 |
| Motions not read-only | `isMotionReadOnly` depends on `already_submitted` from lots (broken by above) AND stale `already_voted` from motions query cache | `VotingPage.tsx` | 251–253 |

---

## Database Changes

None. This is a pure frontend fix.

---

## Backend Changes

None.

---

## Frontend Changes

### `frontend/src/pages/vote/VotingPage.tsx`

**Change: move `sessionStorage.setItem` out of the `setAllLots` functional updater and execute it synchronously, before `navigate` is called.**

The fix involves two steps within `submitMutation.onSuccess`:

1. Compute the updated lots array once (synchronously), outside of any React state updater.
2. Write the updated array to sessionStorage immediately — before calling `navigate`.
3. Pass the already-computed array to `setAllLots` (no longer as a functional updater that computes it; just as the value directly).

Before (current code, lines 149–174):

```tsx
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

  const raw = sessionStorage.getItem(`meeting_lots_${meetingId}`);
  const submittedIds: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  const submittedSet = new Set(submittedIds);

  setAllLots((prev) => {
    const updated = prev.map((lot) =>
      submittedSet.has(lot.lot_owner_id)
        ? { ...lot, already_submitted: true }
        : lot
    );
    if (meetingId) {
      sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(updated));
    }
    return updated;
  });

  setSelectedIds((prev) => {
    const next = new Set(prev);
    for (const id of submittedSet) next.delete(id);
    return next;
  });

  navigate(`/vote/${meetingId}/confirmation`);
},
```

After (fixed code):

```tsx
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

  const raw = sessionStorage.getItem(`meeting_lots_${meetingId}`);
  const submittedIds: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  const submittedSet = new Set(submittedIds);

  // Compute the updated lots array synchronously — outside of React state updaters —
  // so sessionStorage is written before navigate() fires. React Router v6's navigate()
  // uses startTransition internally; the functional updater inside setAllLots may not
  // execute before the component unmounts under concurrent rendering.
  setAllLots((prev) => {
    const updated = prev.map((lot) =>
      submittedSet.has(lot.lot_owner_id)
        ? { ...lot, already_submitted: true }
        : lot
    );
    return updated;
  });

  // Write sessionStorage synchronously here, before navigate, so re-mounting VotingPage
  // reads the correct already_submitted state.
  if (meetingId) {
    const currentLots: LotInfo[] = (() => {
      try {
        return (JSON.parse(sessionStorage.getItem(`meeting_lots_info_${meetingId}`) ?? "[]") as LotInfo[])
          .map((lot) =>
            submittedSet.has(lot.lot_owner_id)
              ? { ...lot, already_submitted: true }
              : lot
          );
      } catch {
        return [];
      }
    })();
    sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(currentLots));
  }

  setSelectedIds((prev) => {
    const next = new Set(prev);
    for (const id of submittedSet) next.delete(id);
    return next;
  });

  navigate(`/vote/${meetingId}/confirmation`);
},
```

**Note:** The `setAllLots` call is kept to keep the in-memory React state consistent for the brief period before navigation. The authoritative write for re-mount purposes is the explicit `sessionStorage.setItem` that runs synchronously before `navigate`.

### Why motions become read-only after this fix

Once sessionStorage is correctly written before navigation:

- On re-mount, `meeting_lots_info_<meetingId>` contains all lots with `already_submitted: true` for the submitted lots.
- `allLots` is set from that value, so `hasUnsubmittedSelected` evaluates to `false` for voters who submitted all their lots.
- `isMotionReadOnly` becomes `m.already_voted && !false` = `m.already_voted`.
- The `motions` query may briefly serve stale data with `already_voted: false`, but a background refetch will return `already_voted: true` and trigger a re-render with fully locked motions.

For the multi-lot partial-submission case (some lots submitted, some not), `hasUnsubmittedSelected` will remain `true`, and motions will remain interactive — which is the correct behaviour.

The stale-cache flash is a secondary cosmetic issue (motions briefly appear interactive for a fraction of a second during the background refetch). This is acceptable and consistent with how TanStack Query works across the app. If a stronger fix is desired in the future, `staleTime` on the motions query could be increased, or the query could be pre-populated from the submission response. That is out of scope for this fix.

---

## Key Design Decisions

1. **Synchronous sessionStorage write before `navigate`** — the core insight is that any state written inside a React functional updater is not guaranteed to persist to side-effects (like sessionStorage) before the component unmounts under concurrent rendering. The fix moves the sessionStorage write to the synchronous scope of `onSuccess`, where it executes unconditionally before `navigate`.

2. **Read-then-update from sessionStorage** — the fixed code reads the current sessionStorage value, applies the `already_submitted: true` mapping to the submitted lot IDs, and writes back. This is equivalent to what the functional updater previously did with `prev`, but in a synchronous context.

3. **Keep `setAllLots` call** — the React state update is still issued so the in-memory component state is consistent if the component somehow stays mounted (e.g. if navigate is delayed). It no longer contains the sessionStorage side-effect.

4. **No backend or API changes** — the server already returns the correct `already_submitted` state on the next auth/session-restore call. This fix only corrects the client-side sessionStorage so that the re-mount (without a re-auth) also reflects the correct state.

5. **No `voted_motion_ids` field added to `LotInfo`** — the motions' read-only state is correctly derived from `m.already_voted` (server) combined with `!hasUnsubmittedSelected` (lot state). Fixing the lot state in sessionStorage is sufficient to make both fields work correctly without adding a new field to `LotInfo` or sessionStorage.

---

## Data Flow (Happy Path After Fix)

1. Voter on `VotingPage` clicks "Submit ballot" → `handleSubmitClick` writes selected lot IDs to `meeting_lots_<meetingId>` in sessionStorage → `handleConfirm` calls `submitMutation.mutate()`.
2. `submitMutation.onSuccess` fires:
   a. `queryClient.invalidateQueries(["motions", meetingId])` marks the motions query stale.
   b. Reads submitted lot IDs from `meeting_lots_<meetingId>`.
   c. Issues `setAllLots(...)` to update in-memory React state.
   d. **Synchronously reads, updates, and writes `meeting_lots_info_<meetingId>` to sessionStorage** with `already_submitted: true` for submitted lots.
   e. Issues `setSelectedIds(...)` to remove submitted lot IDs.
   f. `navigate(`/vote/${meetingId}/confirmation`)` — user lands on `ConfirmationPage`.
3. On `ConfirmationPage`, user clicks "View my votes" → `navigate(`/vote/${meetingId}/voting`)`.
4. `VotingPage` re-mounts. `useEffect` at lines 48–60 reads `meeting_lots_info_<meetingId>` from sessionStorage → finds submitted lots with `already_submitted: true` → sets `allLots` and `selectedIds` (only pending lots selected).
5. `useQuery(["motions", meetingId])` serves stale cache (`already_voted: false`) briefly, then re-fetches from server and returns `already_voted: true`. After re-fetch, `isMotionReadOnly` returns `true` for voted motions.
6. Lots show "Already submitted" badge immediately on mount (from sessionStorage). Motions transition to read-only once the background refetch completes (typically < 500 ms).

---

## Schema Migration Note

No Alembic migration required. No database changes.

---

## E2E Test Scenarios

### Happy path — single-lot voter, "View my votes" shows submitted state

1. Authenticate as a voter with a single lot.
2. On `VotingPage`, cast votes for all motions and submit the ballot.
3. Land on `ConfirmationPage` — assert "Ballot submitted" heading is visible.
4. Click "View my votes".
5. Assert: URL is `/vote/:meetingId/voting`.
6. Assert: The lot shows an "Already submitted" badge.
7. Assert: The lot checkbox is disabled.
8. Assert: All motion cards are read-only (no radio buttons selectable; or read-only visual state).

### Happy path — multi-lot voter, partial submission, returns via "View my votes"

1. Authenticate as a voter with two or more lots.
2. On `VotingPage`, select only a subset of lots, cast votes, and submit.
3. Land on `ConfirmationPage` — "Vote for remaining lots" button is present (because remaining lots exist).
4. Click "Vote for remaining lots".
5. Assert: URL is `/vote/:meetingId/voting`.
6. Assert: Submitted lots show "Already submitted" badge with disabled checkboxes.
7. Assert: Unsubmitted lots do not show the badge and their checkboxes are enabled.
8. Assert: Motion cards are interactive (not read-only) because unsubmitted lots are still pending.

### Happy path — multi-lot voter, all lots submitted, "View my votes" locks everything

1. Authenticate as a voter with two lots.
2. Submit ballot for both lots.
3. Land on `ConfirmationPage`.
4. Click "View my votes" (label, not "Vote for remaining lots").
5. Assert: Both lots show "Already submitted" badge.
6. Assert: All motions are read-only.

### Edge case — page reload after submission (regression guard)

1. Authenticate and submit ballot.
2. While on `ConfirmationPage`, perform a hard browser reload.
3. Navigate to `/vote/:meetingId/voting` directly.
4. Because sessionStorage is cleared on hard reload, `AuthPage` should handle session restore via `localStorage` token.
5. Assert: After session restore, `VotingPage` correctly shows submitted lots (fresh server data via re-auth).

### Regression — existing submit flow still navigates to confirmation

1. Authenticate, vote, and submit.
2. Assert: User is navigated to `ConfirmationPage` (not stuck on `VotingPage`).
3. Assert: Confirmation page shows submitted votes correctly.

---

## Parallel Slice Decomposition

This is a single frontend-only change to one block of code in `VotingPage.tsx`. It does not touch the backend, database, any other frontend component, or any API. No slice decomposition is necessary — it is a single branch, single PR.
