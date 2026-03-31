# Design: Fix — Re-vote Submit Button Missing After New Motions Made Visible

**Status:** Implemented

## Overview

When a voter has already submitted their ballot, and an admin subsequently makes additional motions visible, the voter can log back in and see the new motions — but the Submit button does not appear, and every lot is shown as "Already submitted" even though the new motions have not been voted on. This document diagnoses the root cause across all three layers (auth response, sessionStorage, VotingPage render logic) and designs the fix.

---

## Root Cause Analysis

### Bug 1 (primary): `already_submitted` is lot-level, not motion-aware

**File:** `backend/app/routers/auth.py`, lines 252–258 and 268–274

The auth endpoint computes `already_submitted` per lot by checking whether a `BallotSubmission` row exists for that lot:

```python
submissions_result = await db.execute(
    select(BallotSubmission).where(
        BallotSubmission.general_meeting_id == request.general_meeting_id,
        BallotSubmission.lot_owner_id.in_(all_lot_owner_ids),
    )
)
submitted_lot_ids: set[uuid.UUID] = {s.lot_owner_id for s in submissions_result.scalars().all()}
```

A `BallotSubmission` row is created the first time a lot submits its ballot, and it is never deleted. So after the initial submission, every lot's `already_submitted` flag is `True` — regardless of whether new motions have since been made visible that the lot has not yet voted on.

This flag flows into the `LotInfo` objects returned in `AuthVerifyResponse.lots`, which the frontend stores in `sessionStorage` under `meeting_lots_info_<meetingId>`.

**Result:** Every lot is marked `already_submitted = True` on every subsequent login, even when there are new unvoted motions.

---

### Bug 2 (consequence): SessionStorage is stale across logins

**File:** `frontend/src/pages/vote/AuthPage.tsx`, lines 38–45

On a successful `verifyAuth`, AuthPage filters lots to "pending" based on `already_submitted`:

```typescript
const pendingLots = data.lots.filter((l) => !l.already_submitted);
const pendingLotIds = pendingLots.map((l) => l.lot_owner_id);
sessionStorage.setItem(`meeting_lots_${meetingId}`, JSON.stringify(pendingLotIds));
sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(data.lots));
```

Because all lots are `already_submitted = True` (Bug 1), `pendingLotIds` is an empty array `[]`. The `meeting_lots_<meetingId>` key is written as `[]`, which means when the Submit button is clicked in VotingPage, `submitMutation` reads an empty array and would submit no lots.

---

### Bug 3 (consequence): VotingPage submit button is hidden because `allSubmitted` is `true`

**File:** `frontend/src/pages/vote/VotingPage.tsx`, lines 146–148 and 512–518

VotingPage loads lots from `sessionStorage`:

```typescript
const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
const lots = JSON.parse(raw) as LotInfo[];
setAllLots(lots);
const pending = lots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
setSelectedIds(new Set(pending));
```

Then computes:

```typescript
const allSubmitted = allLots.length > 0 && allLots.every((l) => l.already_submitted);
```

And the submit button is conditionally rendered on line 512:

```typescript
{unvotedMotions.length > 0 && !isClosed && !allSubmitted && (
  <div className="submit-section">
    <button type="button" className="btn btn--primary" onClick={handleSubmitClick}>
      Submit ballot
    </button>
  </div>
)}
```

Because every lot has `already_submitted = True`, `allSubmitted` is `true`, and the submit button is never rendered — even when there are unanswered (newly visible) motions.

---

### Bug 4 (secondary): `unvoted_visible_count` logic has a gap

**File:** `backend/app/routers/auth.py`, lines 279–308

The `unvoted_visible_count` calculation is:

```python
remaining_lot_owner_ids_set = all_lot_owner_ids - submitted_lot_ids

if remaining_lot_owner_ids_set:
    # There are unsubmitted lots — all visible motions are "unvoted" from their perspective
    unvoted_visible_count = len(visible_motions)
else:
    # All lots submitted — count visible motions not yet voted on by this voter email
    unvoted_visible_count = sum(
        1 for m in visible_motions if m.id not in submitted_motion_ids
    )
```

When all lots have previously submitted (`remaining_lot_owner_ids_set` is empty), the backend correctly falls into the `else` branch and counts newly-visible motions not yet voted on. So `unvoted_visible_count` is computed correctly (it will be > 0 when new motions are visible).

However, `AuthPage` checks this and navigates to the voting page correctly:

```typescript
const hasRemainingLots = data.lots.some((l) => !l.already_submitted);
if (hasRemainingLots || data.unvoted_visible_count > 0) {
    navigate(`/vote/${meetingId}/voting`);
}
```

So navigation to VotingPage does happen. The failure is entirely inside VotingPage, where `allSubmitted` blocks the submit button regardless.

---

### Bug 5 (consequence): No lots are selected for submission

Because `already_submitted = True` for all lots, `setSelectedIds` is initialised to an empty set (line 55 of VotingPage), and `meeting_lots_<meetingId>` in sessionStorage contains `[]`. If somehow the button were visible, clicking Submit would call `submitBallot` with an empty `lot_owner_ids` list, which the backend correctly rejects with a 422.

---

### Summary Table

| # | Layer | Location | Root or Consequence |
|---|-------|----------|---------------------|
| 1 | Backend auth | `auth.py` lines 252–258, 268–274 | **Root cause** — `already_submitted` is based solely on `BallotSubmission` existence, not on whether new visible motions remain unvoted |
| 2 | Frontend AuthPage | `AuthPage.tsx` lines 38–45 | Consequence — `meeting_lots_<id>` written as `[]` |
| 3 | Frontend VotingPage | `VotingPage.tsx` line 146, 512–518 | Consequence — submit button hidden because `allSubmitted = true` |
| 4 | Frontend VotingPage | `VotingPage.tsx` line 55 | Consequence — `selectedIds` initialised empty |
| 5 | Frontend VotingPage | `VotingPage.tsx` `submitMutation` | Consequence — would submit no lots even if button were visible |

---

## Correct Behaviour (Specification)

A lot should be treated as "still needs to vote" (i.e. `already_submitted = False` for UX purposes) whenever there is at least one currently-visible motion that the lot has not yet cast a submitted vote on — regardless of whether a `BallotSubmission` row exists.

A lot should only be shown as "Already submitted / done" when every currently-visible motion has a submitted `Vote` row for that lot.

This preserves the invariant that `BallotSubmission` is an audit record (it is never deleted) while fixing the display and routing logic to be motion-aware.

---

## Design

### Backend change — `auth.py` `already_submitted` computation

The `already_submitted` flag on each `LotInfo` must reflect whether the lot has voted on **all currently visible motions**, not just whether a `BallotSubmission` row exists.

#### New logic

1. Fetch all currently visible motion IDs for the meeting (already done for `unvoted_visible_count`, can be reused).
2. For each lot, query the set of submitted `Vote.motion_id` values for that lot.
3. `already_submitted = set(visible_motion_ids).issubset(voted_motion_ids_for_lot)`
   — i.e. the lot is "submitted" only when it has a submitted vote for every visible motion.

This replaces the simple `lo.id in submitted_lot_ids` check.

#### Impact on existing `unvoted_visible_count`

The `unvoted_visible_count` calculation must also be updated. The current two-branch logic (`remaining_lot_owner_ids_set` empty vs. non-empty) worked as a workaround because it happened to count newly visible motions when all lots had a `BallotSubmission`. With the new lot-level `already_submitted` computation, the `unvoted_visible_count` should be derived consistently:

- If any lot has `already_submitted = False` (per new definition), `unvoted_visible_count = len(visible_motions)`.
- Otherwise (all lots fully voted on all visible motions), `unvoted_visible_count = 0`.

This keeps `unvoted_visible_count` accurate and consistent with the lot flags.

#### No schema change required

No new database tables or columns are needed. The change is purely in query logic within the auth endpoint.

---

### Frontend change 1 — `AuthPage.tsx` sessionStorage write

The `meeting_lots_<meetingId>` key must be populated with all lot IDs whose `already_submitted = False` (using the corrected backend value). No frontend logic change is needed here beyond relying on the corrected backend value — but the comment should be updated.

No code change is required in AuthPage once the backend fix is in place, because the filtering `data.lots.filter((l) => !l.already_submitted)` will now correctly return the lots that still have unvoted motions.

---

### Frontend change 2 — `VotingPage.tsx` submit button guard

**File:** `frontend/src/pages/vote/VotingPage.tsx`, line 512

The current condition is:

```typescript
{unvotedMotions.length > 0 && !isClosed && !allSubmitted && (
```

The `!allSubmitted` guard must be removed. With the backend fix, `allSubmitted` will only be `true` when every lot truly has no remaining unvoted visible motions — which means `unvotedMotions.length` will also be 0 (since `unvotedMotions` is derived from `motions.filter((m) => !isMotionReadOnly(m))`). The `!allSubmitted` guard is therefore redundant once the backend is fixed, and keeping it is a second source of breakage.

New condition:

```typescript
{unvotedMotions.length > 0 && !isClosed && (
```

This is the minimal correct condition: show the Submit button if and only if there are motions the voter can still interact with and the meeting is not closed.

---

### Frontend change 3 — `VotingPage.tsx` lot selection initialisation

**File:** `frontend/src/pages/vote/VotingPage.tsx`, line 55

```typescript
const pending = lots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
setSelectedIds(new Set(pending));
```

With the backend fix, `already_submitted` will be `false` for lots with unvoted motions, so `pending` will contain those lots. No change needed here once the backend is fixed.

---

### Frontend change 4 — `VotingPage.tsx` `allSubmitted` "View Submission" button

**File:** `frontend/src/pages/vote/VotingPage.tsx`, lines 349–357 and 466–474

The "View Submission" button in the sidebar and single-lot proxy strip is shown when `allSubmitted` is true. With the backend fix, `allSubmitted` will be `false` when there are unvoted motions — so the "View Submission" button will correctly disappear and the Submit button will appear instead. No change needed here once the backend is fixed.

---

### No backend change to the submit endpoint

`POST /api/general-meeting/{id}/submit` already handles re-entry correctly. In `voting_service.py` `submit_ballot()`:

- Lines 213–222: existing `BallotSubmission` rows are detected and reused (not rejected with 409).
- Lines 224–234: `already_voted_by_lot` tracks which motions each lot has already submitted votes for.
- Lines 310–313: motions already voted on are skipped (`if motion.id in already_voted_for_lot: continue`).

The backend will therefore correctly process a second submission for a lot, inserting only the new motions' vote rows and reusing the existing `BallotSubmission` record. No change is required here.

---

### No schema migration required

All changes are in query logic and frontend render conditions. No new columns, tables, or enum values are introduced.

---

## Data Flow (Happy Path After Fix)

1. **First login:** Voter authenticates. All lots have `already_submitted = False` (no `BallotSubmission` rows exist yet). `meeting_lots_<id>` is written with all lot IDs.
2. **First submit:** Voter answers all 3 visible motions and submits. `BallotSubmission` rows are created for each lot. `Vote` rows with `status = submitted` are created for each (lot, motion) pair.
3. **Admin makes Motion 4 visible.**
4. **Second login:** Voter authenticates again. Backend now runs:
   - Fetches visible motion IDs: {M1, M2, M3, M4}.
   - For each lot, fetches submitted vote motion IDs: {M1, M2, M3}.
   - `{M1, M2, M3, M4}.issubset({M1, M2, M3})` = `False`.
   - Therefore `already_submitted = False` for every lot.
5. **AuthPage:** `pendingLots` = all lots. `meeting_lots_<id>` written with all lot IDs. `meeting_lots_info_<id>` written with all lots having `already_submitted = False`.
6. **AuthPage routing:** `hasRemainingLots = True` → navigate to `/vote/<id>/voting`.
7. **VotingPage loads:** `allLots` populated from sessionStorage with all lots `already_submitted = False`. `selectedIds` initialised with all lot IDs.
8. **Motions fetched:** `GET /motions` returns M1–M4. M1–M3 have `already_voted = True`, M4 has `already_voted = False`.
9. **`unvotedMotions`:** M4 is the only motion where `!isMotionReadOnly(m)` — so `unvotedMotions = [M4]`.
10. **Submit button:** `unvotedMotions.length > 0 && !isClosed` = `true`. Button is visible.
11. **Second submit:** Voter votes on M4 and clicks Submit. `submitBallot` called with all lot IDs and `votes = [{motion_id: M4, choice: "yes"}]`.
12. **Backend:** For each lot, `already_voted_for_lot = {M1, M2, M3}`. M4 is not in that set, so a new submitted `Vote` row is created for M4. The existing `BallotSubmission` is reused.
13. **Navigation:** Voter is sent to the confirmation page.

---

## Key Design Decisions

### Decision 1: Fix `already_submitted` at the source (backend) rather than working around it in the frontend

An alternative would be to keep `already_submitted` as a pure `BallotSubmission` existence flag and add a separate `has_unvoted_visible_motions` field per lot. This would require the frontend to use a new composite signal. The simpler and more coherent approach is to redefine `already_submitted` to mean what the UX needs it to mean: "this lot has finished voting on all currently visible motions." The backend has all the information needed to make this determination correctly.

### Decision 2: Remove `!allSubmitted` guard from submit button rather than adjust `allSubmitted` computation

`allSubmitted` is a derived value — once each lot's `already_submitted` is correct, `allSubmitted` is correct too. Removing the redundant `!allSubmitted` guard is cleaner than leaving it as a second condition that could break again if the semantics of `already_submitted` ever change.

### Decision 3: No change to `BallotSubmission` model

`BallotSubmission` remains an append-only audit record. The fix does not delete, update, or modify submission rows. Only the computation that reads them changes.

---

## Affected Files

### Backend
- `backend/app/routers/auth.py` — rewrite the per-lot `already_submitted` computation and the `unvoted_visible_count` logic

### Frontend
- `frontend/src/pages/vote/VotingPage.tsx` — remove `!allSubmitted` from the submit button condition (line 512)

### Tests
- `backend/tests/test_auth.py` (or equivalent) — add test cases for the revote scenario
- `frontend/src/pages/vote/__tests__/VotingPage.test.tsx` — add test for submit button visible when lots all have `already_submitted = False` but motions have `already_voted = True` for some and `False` for others
- `frontend/src/pages/vote/__tests__/VotingFlow.integration.test.tsx` — add integration scenario for revote flow
- E2E Playwright tests — add scenario described in E2E Test Scenarios section below

---

## E2E Test Scenarios

### Happy path — revote after new motions made visible

1. Seed a meeting with 3 visible motions and 1 hidden motion.
2. Voter authenticates, votes on all 3 visible motions, and submits.
3. Confirm navigation to confirmation page.
4. Admin makes the 4th motion visible.
5. Voter logs back in (re-authenticates via OTP).
6. Assert: voter is routed to `/vote/<id>/voting` (not confirmation).
7. Assert: Motion 4 card is shown and interactive (not read-only).
8. Assert: Motions 1–3 cards are shown as read-only (already voted).
9. Assert: Submit button IS visible.
10. Voter votes on Motion 4 and clicks Submit, then confirms.
11. Assert: voter is routed to confirmation page.
12. Assert: confirmation page shows all 4 motions with their recorded choices.

### Happy path — revote with multi-lot voter

1. Seed a meeting with 3 visible motions. Voter controls Lot A and Lot B.
2. Voter authenticates, votes on all 3 motions, selects both lots, submits.
3. Admin makes a 4th motion visible.
4. Voter logs back in.
5. Assert: both lots shown with unchecked `Already submitted` badge (badge is gone / lots are selectable).
6. Assert: Submit button visible.
7. Voter votes on Motion 4 and submits for both lots.
8. Assert: confirmation page shows both lots with all 4 motions.

### Edge case — all visible motions already voted on (no new motions)

1. Seed a meeting. Voter submits all visible motions.
2. Voter logs back in without any admin changes.
3. Assert: voter is routed to confirmation page (not voting page).
4. Assert: `unvoted_visible_count = 0` in auth response.

### Edge case — meeting closed before second vote

1. Seed a meeting. Voter submits initial ballot.
2. Admin makes a new motion visible, then closes the meeting.
3. Voter logs back in.
4. Assert: voter is routed to confirmation page (meeting is closed).

### Edge case — single lot, re-vote scenario

1. Seed a meeting with single lot voter.
2. Voter submits.
3. Admin makes additional motion visible.
4. Voter logs back in.
5. Assert: `already_submitted = False` in lot list (single-lot strip shows no "Already submitted" badge).
6. Assert: Submit button visible.

### Error — submit with no lot IDs (regression guard)

1. Reproduce the old broken state: manually set `meeting_lots_<id>` in sessionStorage to `[]`.
2. Click Submit.
3. Assert: backend returns 422 (not 500), frontend shows an appropriate error rather than crashing.

---

## Schema Migration Note

**Schema migration required: NO.**

No new tables, columns, or enum values are introduced. All changes are in query logic (backend) and render conditions (frontend).
