# Design: No Pre-fill for Unlocked Motions

## Overview

When a multi-lot voter submits votes for a subset of their lots and then returns to the voting
page to vote for the remaining lots, unlocked motion cards currently render with a pre-selected
choice (e.g. the "For" button appears pressed). This pre-fill comes from the `submitted_choice`
field on the motion, which is seeded into the `choices` state unconditionally for any motion
where `already_voted === true && submitted_choice !== null`.

The correct behaviour is:

- A **locked** (read-only) motion — one where every lot in the reference set has already voted
  on it — may show the prior choice as a display aid, because the voter cannot change it anyway.
- An **unlocked** (interactive) motion must start with no pre-filled choice. The voter must make
  a fresh, explicit selection. Pre-filling an interactive motion is misleading: it implies the
  vote has already been cast, risks silent submission of a stale choice, and breaks the principle
  that only deliberate voter actions should appear in a ballot.

---

## Backend Changes

None. This is a pure frontend state-management change. The backend API response shape
(`MotionOut.submitted_choice`) is unchanged and is still needed — it provides the value to
display on locked motions.

---

## Frontend Changes

### File: `frontend/src/pages/vote/VotingPage.tsx`

#### The seeding effect (lines 126-138)

The existing `useEffect` that seeds `choices` from `motions` currently reads:

```ts
useEffect(() => {
  if (!motions) return;
  setChoices((prev) => {
    const seeded: Record<string, VoteChoice | null> = { ...prev };
    for (const m of motions) {
      if (m.already_voted && m.submitted_choice !== null && !(m.id in seeded)) {
        seeded[m.id] = m.submitted_choice;
      }
    }
    return seeded;
  });
}, [motions]);
```

The condition `!(m.id in seeded)` guards against overwriting an in-session user interaction.
The missing guard is: only seed the choice when the motion is **locked** (`isMotionReadOnly`
returns `true` for that motion).

The updated effect must:

1. Keep the existing `!(m.id in seeded)` guard (no regression for in-session interactions).
2. Add: only seed when `isMotionReadOnly(m)` is `true`.

Because `isMotionReadOnly` depends on `selectedIds` and `allLots` (not just `motions`), the
effect's dependency array must include `isMotionReadOnly`.

The new condition becomes:

```
m.already_voted && m.submitted_choice !== null && !(m.id in seeded) && isMotionReadOnly(m)
```

#### Dependency array

`isMotionReadOnly` is a stable function reference created inline on each render (not
memoised). Adding it to the dependency array of the seeding `useEffect` means the effect
re-runs whenever the derived lock state changes — which is the correct behaviour: if the
voter selects or deselects lots and a motion transitions from locked to unlocked, the
seeded value should be cleared (see "clearing stale seeded values" below).

However, simply adding `isMotionReadOnly` to `[motions]` and calling it a day will not
clear a choice that was seeded while the motion was locked but the voter has since made the
motion unlocked (by re-selecting a lot whose `voted_motion_ids` does not include the
motion). The seeding effect uses `!(m.id in seeded)` as a one-way guard, so once seeded the
value is never removed by the seeding effect alone.

**Clearing unlocked motions:** When a motion transitions from locked to unlocked, its
previously seeded `choices` entry should be wiped. The cleanest approach is to extend the
seeding effect to also **clear** any choice entry for a motion that is currently unlocked
and was seeded (i.e. it is in `seeded` but `isMotionReadOnly(m)` is now false). This
requires distinguishing "seeded by the effect" from "set by the user". The simplest
mechanism is a second state variable, `seededMotionIds: Set<string>`, tracking which motion
IDs had their choice set by the seeding effect (not by user interaction). When a motion is
no longer read-only and its ID is in `seededMotionIds`, the choice is nulled out.

**Alternative — simpler approach:** Given the scenarios in the acceptance criteria and the
existing test suite, the scope of the problem is narrower than a full locking-transitions
tracker:

- A motion is locked from the moment the page loads (all selected lots have it in
  `voted_motion_ids`) — it should pre-fill.
- A motion is unlocked on load — it must not pre-fill. The seeding effect fires when
  `motions` loads, at which point `isMotionReadOnly` can be evaluated directly.
- A motion becoming unlocked mid-session (voter deselects a lot) — clearing the stale fill
  is a nice-to-have but is not in scope for this change. The mixed-selection warning dialog
  already alerts the voter when lots have differing vote coverage, providing an alternative
  safety net.

The **minimum correct change** is therefore: in the seeding condition, also require
`isMotionReadOnly(m) === true`. Since the seeding effect fires when `motions` loads (at
which point `allLots` and `selectedIds` are already populated from sessionStorage), this
correctly prevents pre-fill for unlocked motions on page load and on revote scenarios.

The dependency array changes from `[motions]` to `[motions, isMotionReadOnly]`. Because
`isMotionReadOnly` is an inline function that is recreated on every render, this broadens
the effect's trigger surface (it fires on every render where `motions` or the lot selection
state changes). To avoid runaway re-renders, `isMotionReadOnly` should be wrapped in
`useCallback` (it already has `selectedIds`, `allLots` as implicit dependencies via closure
— make those explicit).

**Recommended implementation plan:**

1. Memoize `isMotionReadOnly` with `useCallback`:

```ts
const isMotionReadOnly = useCallback(
  (m: { id: string }) => {
    return (
      readOnlyReferenceLots.length > 0 &&
      readOnlyReferenceLots.every((lot) => (lot.voted_motion_ids ?? []).includes(m.id))
    );
  },
  [readOnlyReferenceLots]
);
```

   `readOnlyReferenceLots` is already a derived variable computed before `isMotionReadOnly`
   is defined in the component, so this is a straightforward wrap.

2. Update the seeding effect condition and dependency array:

```ts
useEffect(() => {
  if (!motions) return;
  setChoices((prev) => {
    const seeded: Record<string, VoteChoice | null> = { ...prev };
    for (const m of motions) {
      if (
        m.already_voted &&
        m.submitted_choice !== null &&
        !(m.id in seeded) &&
        isMotionReadOnly(m)   // NEW guard: only pre-fill locked motions
      ) {
        seeded[m.id] = m.submitted_choice;
      }
    }
    return seeded;
  });
}, [motions, isMotionReadOnly]);
```

No other files need to change.

---

## Edge Cases

### 1. Voter has all lots selected (normal first-time vote)

All motions are unlocked (no lot has voted on any motion, `voted_motion_ids` is empty for
all lots). `isMotionReadOnly` returns `false` for every motion. The new guard prevents any
seeding. Behaviour is identical to the existing behaviour for a first-time voter.

### 2. Voter returns after submitting a subset of lots

Example: 3 lots. Lot A and Lot B submitted; Lot C not yet submitted. The voter returns to
vote for Lot C.

- `selectedIds` will contain only `lo-C` (Lot C is the only pending lot, per the existing
  `[motions, allLots, isLotSubmitted]` effect).
- `readOnlyReferenceLots` = lots in `selectedIds` = `[Lot C]`.
- For a motion that Lot A and Lot B voted on but Lot C has not: `isMotionReadOnly` returns
  `false` (Lot C's `voted_motion_ids` does not include it). The new guard blocks seeding.
  The card renders with no pre-fill. The voter must choose.
- For a motion that ALL lots (A, B, and C) voted on: `isMotionReadOnly` returns `true`. The
  card is read-only and may show the prior choice. This scenario means Lot C already voted
  on this motion in a previous session (the motion was voted on before Lot C submitted its
  subset). Pre-filling a read-only card is harmless — the voter cannot interact with it.

### 3. Voter deselects all lots (Deselect All button)

`selectedIds` is empty. `readOnlyReferenceLots` falls back to `allLots` (the existing
fallback: `selectedLots.length > 0 ? selectedLots : allLots`). All lots are submitted
(Deselect All is only meaningful when all lots are submitted), so all motions are locked.
Pre-fill is kept for locked read-only cards. No interactive cards exist. No behaviour change.

### 4. Single-lot voter, no prior submission

`isMotionReadOnly` returns `false` for all motions (lot has no voted motions). New guard
prevents seeding. No behaviour change from the current state (the default handler already
returns blank for motions with `already_voted=false`).

### 5. Single-lot voter, fully submitted (all motions in `voted_motion_ids`)

All motions are locked. `isMotionReadOnly` returns `true` for all of them. Seeding is
allowed. Cards display the previously submitted choice in read-only mode. No change from
current behaviour.

### 6. Multi-lot voter: motion partially locked (some selected lots voted, others not)

`isMotionReadOnly` returns `false` (at least one selected lot has not voted on the motion).
New guard prevents seeding. Card is interactive and starts blank. This is the primary
scenario this feature addresses.

---

## Data Flow (Happy Path — Revote Scenario)

1. Voter authenticates. Lots `[A, B, C]` are returned. `already_submitted` is `false` for
   Lot C; `true` for Lots A and B (all current motions are in their `voted_motion_ids`).

2. `sessionStorage` is populated with all three lots. On VotingPage mount, `allLots` and
   `selectedIds` are set. The `[motions, allLots, isLotSubmitted]` effect runs: since Lots A
   and B are submitted (all motions in their `voted_motion_ids`) and Lot C is not,
   `selectedIds` = `{lo-C}`.

3. `motions` loads. Server returns Motion 1 (`already_voted: true`, `submitted_choice: "yes"`)
   and Motion 2 (`already_voted: false`, `submitted_choice: null`).

4. The seeding `useEffect` runs. `isMotionReadOnly` is evaluated for each motion:
   - Motion 1: `readOnlyReferenceLots` = `[Lot C]`. Lot C's `voted_motion_ids` contains
     Motion 1? Depends on whether Lot C participated in the prior round. If not, Motion 1
     is unlocked — new guard blocks seeding. Card renders blank.
   - Motion 2: `already_voted: false` so the first condition (`m.already_voted`) is already
     `false`. Not seeded regardless. Card renders blank.

5. Voter selects choices for both motions and submits for Lot C.

---

## Schema Migration

Not required. This is a frontend-only change.

---

## Key Design Decisions

- **Minimal scope**: Only the seeding guard changes. No new state variables, no tracking of
  which values were "seeded vs user-set". This keeps the diff small and the risk surface low.
- **Memoize `isMotionReadOnly`**: Wrapping it in `useCallback` makes it safe to include in
  the `useEffect` dependency array without causing infinite re-render loops.
- **No clearing of already-seeded values**: If a motion was seeded while locked and the voter
  then deselects a lot (making the motion unlocked mid-session), the stale value is not
  automatically cleared by this change. The mixed-selection warning dialog provides a
  sufficient safety net for this edge case, and clearing mid-session would require additional
  state tracking that is out of scope.
- **`readOnlyReferenceLots` as the anchor**: The existing `readOnlyReferenceLots` variable
  (which already handles the "no selected lots" fallback) is reused as the dependency for
  `useCallback`, keeping the lock-state logic in one place.

---

## E2E Test Scenarios

### Unit / integration tests to update

**File: `frontend/src/pages/vote/__tests__/VotingPage.test.tsx`**

The existing test at line 1575 (`"choices seeded from submitted_choice when motions load
(revote scenario)"`) seeds Motion 1 with `already_voted: true, submitted_choice: "yes"` and
then asserts that the "For" button for Motion 1 is `aria-pressed="true"`. This test uses a
single-lot sessionStorage fixture where the lot has an **empty** `voted_motion_ids` array.
Under the new behaviour, Motion 1 is not locked (the single lot has not voted on it), so the
seeding must not happen. **This test must be updated:**

- Scenario A (kept as new test): Motion is locked — lot's `voted_motion_ids` contains
  Motion 1 → seeding is allowed → "For" button aria-pressed="true".
- Scenario B (replaces current test): Motion is unlocked — lot's `voted_motion_ids` does NOT
  contain Motion 1 (even though `already_voted: true`) → seeding is blocked → "For" button
  aria-pressed="false".

**Tests to add:**

1. **Unlocked motion: no pre-fill despite `submitted_choice`**
   - Setup: 1 lot, `voted_motion_ids: []`. Motions: Motion 1 (`already_voted: true`,
     `submitted_choice: "yes"`), Motion 2 (`already_voted: false`, `submitted_choice: null`).
   - Assert: "For" buttons for both motions are `aria-pressed="false"`.
   - Assert: progress bar shows `0 / 2 motions answered`.

2. **Locked motion: pre-fill is applied**
   - Setup: 1 lot, `voted_motion_ids: [MOTION_ID_1, MOTION_ID_2]`. Both motions:
     `already_voted: true`, `submitted_choice: "yes"` / `"no"`.
   - Assert: Motion 1 "For" button `aria-pressed="true"`. Motion 2 "Against" button
     `aria-pressed="true"`.
   - Assert: Both motion cards show "Already voted" badge (read-only).

3. **Mixed lock state: locked motion pre-fills, unlocked does not**
   - Setup: 1 lot, `voted_motion_ids: [MOTION_ID_1]`. Motion 1: locked (in
     `voted_motion_ids`), `submitted_choice: "yes"`. Motion 2: unlocked (not in
     `voted_motion_ids`), `already_voted: false`, `submitted_choice: null`.
   - Assert: Motion 1 "For" button `aria-pressed="true"`.
   - Assert: Motion 2 "For" button `aria-pressed="false"`.

4. **Multi-lot partial submit: unlocked motions start blank**
   - Setup: Lots A (`voted_motion_ids: [MOTION_ID_1]`) and Lot B (`voted_motion_ids: []`).
     Motion 1 (`already_voted: true`, `submitted_choice: "yes"`), Motion 2 unlocked.
   - `selectedIds` will contain Lot B only (Lot A is not fully submitted because Motion 2
     is not in its `voted_motion_ids` — or adjust the fixture so that Lot A is submitted and
     Lot B is not).
   - Adjusted fixture: Lot A `voted_motion_ids: [MOTION_ID_1, MOTION_ID_2]` (fully
     submitted), Lot B `voted_motion_ids: []` (pending). `selectedIds` = `{lo-B}`.
   - Motion 1: `isMotionReadOnly` for Lot B = false (not in Lot B's `voted_motion_ids`) →
     no pre-fill.
   - Assert: All "For"/"Against"/"Abstained" buttons for Motion 1 are `aria-pressed="false"`.

5. **In-session guard still works: user interaction not overwritten by seeding**
   - This is covered by the existing test `"existing user interaction not overwritten by
     submitted_choice seeding"` (line 1620). Verify it still passes under the new code.
   - Note: in this test the lot's `voted_motion_ids` is empty, so Motion 1 will not be
     seeded at all under the new behaviour. The test assertion (that the user's "no" click
     is not overwritten) will still hold but for a different reason. The test should be
     updated to use a fixture where the motion IS locked initially (in `voted_motion_ids`),
     then the user changes it — confirming user interaction takes precedence over seeding
     even when the motion was locked at load time.

### E2E (Playwright) scenarios

These tests run against the deployed preview environment and require seeding state via
the API (restoreSession or sessionStorage manipulation in `page.evaluate`).

**Scenario 1 — Happy path: first-time voter sees blank motions**
- Authenticate as a voter with no prior submissions.
- Navigate to VotingPage.
- Assert: All motion cards show no button as pressed.

**Scenario 2 — Revote after partial submit: unlocked motions blank, locked motions pre-filled**
- Seed sessionStorage so the voter has 2 lots: Lot A fully submitted (both motions in
  `voted_motion_ids`), Lot B pending (no motions in `voted_motion_ids`).
- Stub motions API to return Motion 1 (`already_voted: true`, `submitted_choice: "yes"`)
  and Motion 2 (`already_voted: false`, `submitted_choice: null`).
- Navigate to VotingPage.
- `selectedIds` = `{Lot B}`. Motion 1: Lot B has not voted → unlocked → no pre-fill.
- Assert: Motion 1 "For" button not pressed.
- Assert: Motion 2 "For" button not pressed.

**Scenario 3 — All lots fully submitted: locked motions show prior choice**
- Seed sessionStorage so the voter has 1 lot, fully submitted (both motions in
  `voted_motion_ids`).
- Stub motions API: both motions `already_voted: true`, one with `submitted_choice: "yes"`,
  one with `submitted_choice: "no"`.
- Navigate to VotingPage.
- Assert: Motion 1 "For" button pressed (aria-pressed="true"), card shows "Already voted".
- Assert: Motion 2 "Against" button pressed, card shows "Already voted".
- Assert: No "Submit ballot" button visible.

**Scenario 4 — Edge case: voter deselects all lots**
- Seed 2 fully-submitted lots.
- Navigate to VotingPage.
- Click "Deselect All".
- Assert: All motion cards remain read-only ("Already voted" badge visible).
- Assert: No motion card buttons become interactive.
