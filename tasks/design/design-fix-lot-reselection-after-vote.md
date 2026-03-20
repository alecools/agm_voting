# Design: Fix Lot Re-selection After Vote (BUG-LS-01)

## Overview

After a voter submits their ballot for one or more lots and then navigates back to the voting page
(via the Back button or a direct URL), all lots — including ones just submitted — are shown as
fully interactive. The user can re-select a submitted lot, fill in choices, and click Submit again.
The backend silently ignores the re-submission (returns 409), but the user receives no feedback and
may believe their second submission was recorded.

The fix has two independent parts that must both land together:

1. **After a successful submission, update the in-memory lot state** so submitted lots are
   immediately marked `already_submitted: true` in the React component that holds that state
   (`VotingPage`). This makes the already-submitted visual indicators appear instantly without
   waiting for the next auth call.

2. **Sync sessionStorage after a successful submission** so that if the user navigates away and
   returns to `/vote/:id/voting` within the same browser session, the persisted lot data reflects
   the current submission state.

No backend changes are required.

---

## Root Cause

### Exact location

`frontend/src/pages/vote/VotingPage.tsx`, `submitMutation.onSuccess` callback (lines 130–133):

```typescript
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });
  navigate(`/vote/${meetingId}/confirmation`);
},
```

After a successful submit the handler:
- invalidates the motions query (correct)
- immediately navigates to the confirmation page

It does **not**:
- update `allLots` state to mark the just-submitted lots as `already_submitted: true`
- update `meeting_lots_info_<meetingId>` in sessionStorage to reflect the new submission state

### Why this matters on back navigation

`VotingPage` loads its lot list exclusively from sessionStorage on mount (lines 48–60):

```typescript
useEffect(() => {
  const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
  const lots = JSON.parse(raw) as LotInfo[];
  setAllLots(lots);
  const pending = lots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
  setSelectedIds(new Set(pending));
}, [meetingId]);
```

Because `meeting_lots_info_<meetingId>` was never updated after the submission, it still shows the
submitted lots with `already_submitted: false`. On back navigation, `allLots` is re-initialised
from that stale data, making every lot appear unsubmitted.

### Is the auth endpoint re-called on back navigation?

No. `POST /api/auth/verify` is called only once per OTP verification. Navigation between
`/voting` and `/confirmation` within the same session does not re-trigger auth. The voter's lot
list is served entirely from sessionStorage (`meeting_lots_info_<meetingId>`), which is set once
in `AuthPage.tsx` (line 43) and never updated afterwards.

### Does `already_submitted` flow through to disable checkboxes?

Yes — once the flag is correct. In `VotingPage.tsx` the lot-list render at line 317 disables the
checkbox `disabled={lot.already_submitted}` and shows the "Already submitted" badge when
`lot.already_submitted` is true. The logic is correct; the data is wrong because sessionStorage is
never refreshed.

### Why the "Back" button lands on VotingPage, not AuthPage

`VotingPage.tsx` line 397:

```typescript
<button onClick={() => navigate(`/vote/${meetingId}`)}>← Back</button>
```

This navigates to `/vote/:meetingId` (the BuildingSelectPage / home), not back to `/vote/:meetingId/auth`.
The user does not pass through AuthPage again, so auth is never re-called and session storage is
never refreshed. The defect description says "navigate back to lot selection screen" — this actually
means the user navigates to the confirmation page (submitted), then uses the browser Back button or
the "Vote for remaining lots" button to return to `/voting`, bypassing auth entirely.

---

## What the lot-selection UI should look like for submitted lots

The UI already has the correct visual pattern — it just receives stale data. When `already_submitted`
is true for a lot, `VotingPage` already:

- adds class `lot-selection__item--submitted` to the list item
- sets `disabled={true}` on the checkbox
- shows `<span class="lot-selection__badge lot-selection__badge--submitted">Already submitted</span>`

No new UI component or style is needed. The fix is purely data: ensure that `already_submitted` is
set to `true` for the submitted lots immediately after a successful submit call.

---

## Frontend Changes

### `frontend/src/pages/vote/VotingPage.tsx`

#### Change 1 — Update `allLots` state in `submitMutation.onSuccess`

After a successful submission, iterate over `selectedIds` (the lot IDs that were just submitted)
and update `allLots` in place, setting `already_submitted: true` for each submitted lot.

Updated `onSuccess`:

```typescript
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

  // Mark the just-submitted lots as already_submitted in local state
  setAllLots((prev) => {
    const updated = prev.map((lot) =>
      selectedIds.has(lot.lot_owner_id)
        ? { ...lot, already_submitted: true }
        : lot
    );
    // Sync sessionStorage so that back-navigation within the session reflects the new state
    if (meetingId) {
      sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(updated));
    }
    return updated;
  });

  navigate(`/vote/${meetingId}/confirmation`);
},
```

The `selectedIds` snapshot is captured at submit time (when `handleSubmitClick` writes to
sessionStorage on line 226). By the time `onSuccess` fires, `selectedIds` still holds the IDs
that were submitted.

#### Change 2 — Update `selectedIds` to exclude newly-submitted lots

After the state update above, `setSelectedIds` should remove the submitted lot IDs. Because
`setAllLots` already marks those lots `already_submitted: true`, the existing checkbox `disabled`
logic will handle them. However, explicitly clearing `selectedIds` prevents a race where the old
`selectedIds` value is used before React re-renders.

This is included in the same `onSuccess` callback:

```typescript
setSelectedIds((prev) => {
  const next = new Set(prev);
  for (const id of submittedIds) next.delete(id);
  return next;
});
```

`submittedIds` is captured from `selectedIds` at the moment `handleSubmitClick` is called (same
snapshot already written to `meeting_lots_<meetingId>` in sessionStorage).

#### Implementation note

Because `selectedIds` is a `Set<string>` held in React state and closures capture it at the time
the mutation is triggered, the simplest approach is:

1. In `handleSubmitClick`, capture `const submittedIds = new Set(selectedIds)` (or read it from
   the sessionStorage key written at that point — same values).
2. Store `submittedIds` in a `useRef` so `onSuccess` can read it without a stale closure.

Alternatively, read the submitted IDs directly from
`JSON.parse(sessionStorage.getItem(`meeting_lots_${meetingId}`))` in `onSuccess` — this value was
written by `handleSubmitClick` and is available synchronously.

The recommended approach: read from sessionStorage in `onSuccess` to avoid ref management.

```typescript
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

  // Determine which lot IDs were just submitted (written to sessionStorage by handleSubmitClick)
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

### No backend changes required

The backend already returns 409 for duplicate submissions and correctly handles the case where
`lot_owner_ids` contains already-submitted lots (it skips them silently). The `already_submitted`
flag in `AuthVerifyResponse` is computed fresh on each auth call and is correct — it is the
client-side caching that is broken.

---

## Data Flow (Happy Path After Fix)

1. Voter authenticates via `POST /api/auth/verify`.
2. `AuthPage.onSuccess` writes the full lot list (including `already_submitted` flags from the
   server) to `meeting_lots_info_<meetingId>` in sessionStorage and navigates to `/voting`.
3. `VotingPage` mounts, reads `meeting_lots_info_<meetingId>`, sets `allLots` with all lots shown
   as unsubmitted.
4. Voter selects lots A and B, fills in choices, clicks Submit.
5. `handleSubmitClick` writes `[idA, idB]` to `meeting_lots_<meetingId>` in sessionStorage.
6. `submitMutation` fires `POST /api/general-meeting/:id/submit` with `lot_owner_ids: [idA, idB]`.
7. Backend records the ballot. Returns 200.
8. `onSuccess`:
   a. Reads `[idA, idB]` from `meeting_lots_<meetingId>`.
   b. Calls `setAllLots` — updates lots A and B to `already_submitted: true`.
   c. Updates `meeting_lots_info_<meetingId>` in sessionStorage with the new `allLots`.
   d. Calls `setSelectedIds` — removes idA and idB from selection.
   e. Navigates to `/confirmation`.
9. If voter navigates back to `/voting` (Back button, direct URL):
   a. `VotingPage` mounts again, reads `meeting_lots_info_<meetingId>` from sessionStorage.
   b. Lots A and B are loaded with `already_submitted: true`.
   c. Their checkboxes are rendered `disabled`, "Already submitted" badge shown.
   d. Only lot C (if any) remains selectable.

---

## Key Design Decisions

### Why not re-call `POST /api/auth/verify` on back navigation?

Re-calling auth requires a live OTP, which is single-use. A second call would require the user to
re-authenticate. The simpler and correct fix is to update client-side state immediately after
submit, eliminating the need for a server round-trip.

### Why not navigate to a different route after submit?

The current navigation to `/confirmation` is correct. The issue is only on the return path. Fixing
the state/sessionStorage update is sufficient.

### Why sessionStorage (not React context or a global store)?

The app has no React context or global state store — lot data flows exclusively through
sessionStorage between pages. Updating sessionStorage is the correct layer for persistence across
navigation events within the same browser session. React state handles within-page rendering; the
two must be kept in sync.

### Why not hide submitted lots instead of disabling them?

The existing UI pattern (confirmed in the multi-lot sidebar in `VotingPage.tsx` lines 305–343) is
to show submitted lots with a disabled checkbox and an "Already submitted" badge. This is
consistent with the `handleSelectAll`, `handleSelectProxy`, `handleSelectOwned` handlers which
already filter out `already_submitted` lots. No new UI pattern is needed.

---

## Schema Migration Note

No database schema changes are required. This is a frontend-only fix.

Schema migration needed: **no**

---

## Tests to Add or Update

### Unit tests (`frontend/src/pages/vote/__tests__/VotingPage.test.tsx`)

Add a new describe block `"after successful submit"`:

- **After submit: submitted lots are marked already_submitted in the lot sidebar**
  - Seed sessionStorage with two lots, both `already_submitted: false`
  - Trigger a submit (click Submit, confirm dialog)
  - After navigation mock fires, assert that the lot sidebar shows the "Already submitted" badge
    for the submitted lots
  - Assert their checkboxes are disabled

- **After submit: sessionStorage meeting_lots_info is updated**
  - Same setup as above
  - After submit success, read `meeting_lots_info_<meetingId>` from sessionStorage
  - Assert that submitted lot IDs have `already_submitted: true` in the stored JSON

- **After submit: remaining unsubmitted lots stay selectable**
  - Seed sessionStorage with three lots (A, B, C); submit only A and B
  - After submit success, assert that lot C's checkbox is not disabled

- **Back navigation with stale sessionStorage: submitted lots render as disabled (regression)**
  - Seed sessionStorage with two lots where both are `already_submitted: true`
    (simulating the updated post-submit sessionStorage)
  - Re-render VotingPage from scratch
  - Assert both lot checkboxes are disabled and "Already submitted" badges are shown

### Integration test (`frontend/src/pages/vote/__tests__/VotingFlow.integration.test.tsx`)

- **Multi-lot partial submit: second lot remains selectable, first is disabled after first submit**
  - Render AuthPage → submit OTP → land on VotingPage with two lots
  - Submit lot A
  - Assert lot A is disabled with "Already submitted" badge
  - Assert lot B is still selectable (checkbox enabled)

### E2E test scenarios

See section below.

---

## E2E Test Scenarios

Add a new test file or extend `frontend/e2e/multi-lot-voting.spec.ts`.

### Scenario: Submitted lot is disabled after voting and back navigation

**Tags:** happy path, regression

1. Seed a building with two lots (ML-FIXLS-1, ML-FIXLS-2) sharing one email.
2. Authenticate via OTP as that email.
3. Assert both lots appear as selectable (checkboxes enabled) on the voting page.
4. Vote all motions for both lots; submit; confirm dialog.
5. Assert navigation to `/confirmation`.
6. Click Back (or navigate directly to `/vote/:id/voting`).
7. Assert both lots show "Already submitted" badge.
8. Assert both lot checkboxes are `disabled`.
9. Assert the Submit ballot button is absent (no unsubmitted lots remain).
10. Assert the "View Submission" button is present.

### Scenario: Partial submission — one lot done, other remains selectable

**Tags:** happy path, state-based

1. Seed a building with three lots (ML-FIXLS-A, ML-FIXLS-B, ML-FIXLS-C) sharing one email.
2. Authenticate via OTP.
3. Deselect lot C from the sidebar; submit for lots A and B.
4. Navigate back to `/vote/:id/voting`.
5. Assert lots A and B show "Already submitted" badge with disabled checkboxes.
6. Assert lot C's checkbox is enabled and selectable.
7. Select lot C, fill in choices, submit.
8. Navigate to confirmation and assert all three lots appear in the ballot summary.

### Scenario: Re-submission attempt is rejected gracefully

**Tags:** error case

1. Complete full submission for all lots.
2. Directly navigate to `/vote/:id/voting` (bypassing confirmation page).
3. Manually clear `meeting_lots_info_<meetingId>` from sessionStorage (devtools or
   test helper) to simulate the pre-fix state where lots appear unsubmitted.
4. Attempt to submit again.
5. Assert that the 409 response causes navigation to `/confirmation` (not a silent no-op
   and not an error page).

### Scenario: Auth re-entry after full submission still shows confirmation

**Tags:** state-based (regression — existing scenario 3 in multi-lot-voting.spec.ts)

Already covered by the existing Scenario 3 / 4 in `multi-lot-voting.spec.ts`. Verify these
continue to pass after the fix.

### Scenario: Single-lot voter — submitted state persists after back navigation

**Tags:** happy path, boundary

1. Seed a building with one lot.
2. Authenticate, vote, submit.
3. Navigate back to `/vote/:id/voting`.
4. Assert the single-lot inline strip shows "Already submitted" badge.
5. Assert no Submit ballot button is shown.
