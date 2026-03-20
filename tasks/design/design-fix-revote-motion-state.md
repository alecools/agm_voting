# Design: Fix revote motion state — previously-voted motions shown as unvoted on re-entry

## Overview

When a voter has submitted votes for motions 1, 2, and 3 and an admin subsequently makes motion 4 visible, the voter re-authenticates and correctly reaches the voting page (BUG-RV-01 is already fixed). However, motions 1, 2, and 3 display with no pre-selected choice — the vote buttons all appear blank. The voter cannot see what they previously voted and can inadvertently submit different choices for motions that have already been answered (the backend will silently ignore those overrides, but the voter experience is confusing and misleading).

**Schema migration needed: no.**

---

## Root Cause Analysis

The defect spans two layers.

### Layer 1 — Backend: `GET /api/general-meeting/{id}/motions` returns `already_voted` but the frontend ignores it for pre-populating choices

The `list_motions` endpoint in `voting.py` already computes and returns `already_voted: bool` per `MotionOut`. The flag is correctly set to `true` for any motion that has a submitted `Vote` row for any of the voter's lot owner IDs. This part works correctly.

However, `MotionOut` does NOT return the voter's previously submitted `choice` value for already-voted motions. The response shape is:

```
MotionOut {
  id, title, description, order_index, motion_type, is_visible, already_voted
}
```

There is no `submitted_choice` field. So even though the frontend knows a motion was already voted on, it has no choice value to display in the locked card.

### Layer 2 — Frontend: `VotingPage` initialises `choices` as an empty object on every mount

`VotingPage.tsx` line 32:

```ts
const [choices, setChoices] = useState<Record<string, VoteChoice | null>>({});
```

`choices` is always initialised empty — there is no logic to pre-populate it from prior submitted votes. The `motions` query result includes `already_voted: true` for previously-submitted motions, and `VotingPage` uses that flag correctly to mark those motions `readOnly` (via `isMotionReadOnly`). However, `MotionCard` renders the vote buttons with `choice={choices[motion.id] ?? null}`, which is always `null` for a freshly mounted page.

Result: the "Already voted" badge appears on the card header (because `readOnly` is passed), but the vote buttons all render in their unselected state. The voter cannot see what they originally voted.

### Layer 3 — Backend: submit endpoint already hardened (no change needed)

`submit_ballot` in `voting_service.py` builds `already_voted_by_lot` before processing and skips motions in that set (lines 311–313):

```python
if motion.id in already_voted_for_lot:
    continue
```

This means even if the frontend were to include previously-voted motions in the submission request, the backend silently ignores them. The existing vote rows are not overwritten. This layer is already correct.

### Summary

| Layer | Issue | Fix needed? |
|---|---|---|
| Backend `list_motions` | Does not return prior `choice` for already-voted motions | Yes — add `submitted_choice` field |
| Frontend `VotingPage` | Does not seed `choices` state from prior votes | Yes — pre-populate from `submitted_choice` |
| Frontend `MotionCard` | `readOnly` rendering already exists and is correct | No |
| Backend `submit_ballot` | Already skips already-voted motions silently | No |

---

## Database Changes

None. All required data exists in the `votes` table (`Vote.choice`, `Vote.status == submitted`, `Vote.lot_owner_id`, `Vote.motion_id`).

---

## Backend Changes

### 1. `MotionOut` schema — add `submitted_choice` field

**File:** `backend/app/schemas/voting.py`

Add an optional `submitted_choice` field to `MotionOut`:

```python
class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: Optional[str]
    order_index: int
    motion_type: MotionType
    is_visible: bool = True
    already_voted: bool = False
    submitted_choice: Optional[VoteChoice] = None   # NEW
```

`submitted_choice` is `null` for motions not yet voted on, and the `VoteChoice` value for motions that have an existing submitted vote. Since a voter may have multiple lots, and all lots vote with the same set of choices (the choices are per-session, not per-lot), we return the choice from any submitted vote for this motion — all lots for the same session will have voted the same way on a given motion (with the exception of `not_eligible` for in-arrear lots on general motions; see note below).

**Note on multi-lot / in-arrear edge case:** For a multi-lot voter where some lots are in-arrear, different lots may have different `Vote.choice` values for the same general motion (e.g., `yes` for a normal lot, `not_eligible` for an in-arrear lot). The display choice should be the voter's intentional choice (`yes`/`no`/`abstained`), not `not_eligible` (which is a system-generated ineligibility marker). The selection logic in `list_motions` should prefer a non-`not_eligible` choice when one exists among the submitted votes for this motion.

### 2. `list_motions` endpoint — populate `submitted_choice`

**File:** `backend/app/routers/voting.py`

The endpoint currently fetches `voted_motion_ids` (a set of motion UUIDs). It needs to additionally fetch the choice for each voted motion.

Change the `voted_result` query to return `(Vote.motion_id, Vote.choice)` tuples:

```python
voted_result = await db.execute(
    select(Vote.motion_id, Vote.choice).where(
        Vote.general_meeting_id == general_meeting_id,
        Vote.lot_owner_id.in_(all_lot_owner_ids),
        Vote.status == VoteStatus.submitted,
    )
)
```

Build a `voted_choice_by_motion: dict[uuid.UUID, VoteChoice]` from the results, preferring a non-`not_eligible` choice if multiple rows exist for the same motion:

```python
voted_choice_by_motion: dict[uuid.UUID, VoteChoice] = {}
for motion_id, choice in voted_result.all():
    existing = voted_choice_by_motion.get(motion_id)
    # Prefer any non-not_eligible choice over not_eligible
    if existing is None or existing == VoteChoice.not_eligible:
        voted_choice_by_motion[motion_id] = choice
```

`voted_motion_ids` becomes `set(voted_choice_by_motion.keys())` (no separate set needed).

Update the `MotionOut` construction:

```python
return [
    MotionOut(
        id=m.id,
        title=m.title,
        description=m.description,
        order_index=m.order_index,
        motion_type=m.motion_type,
        is_visible=m.is_visible,
        already_voted=m.id in voted_motion_ids,
        submitted_choice=voted_choice_by_motion.get(m.id),  # NEW
    )
    for m in motions
]
```

No new endpoint is required. The change is backward-compatible (new optional field on an existing response).

---

## Frontend Changes

### 1. `voter.ts` API type — add `submitted_choice` to `MotionOut`

**File:** `frontend/src/api/voter.ts`

```ts
export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
  is_visible: boolean;
  already_voted: boolean;
  submitted_choice: VoteChoice | null;   // NEW
}
```

### 2. `VotingPage.tsx` — seed `choices` from `submitted_choice` when motions load

**File:** `frontend/src/pages/vote/VotingPage.tsx`

After the `motions` query resolves, populate the `choices` state for any motion where `already_voted === true` and `submitted_choice !== null`. This must only happen once (on initial load), not on every re-render.

Add a `useEffect` that depends on `motions`:

```ts
useEffect(() => {
  if (!motions) return;
  setChoices((prev) => {
    const seeded: Record<string, VoteChoice | null> = { ...prev };
    for (const m of motions) {
      // Only seed if not already set in state (avoid overwriting user interactions)
      if (m.already_voted && m.submitted_choice !== null && !(m.id in seeded)) {
        seeded[m.id] = m.submitted_choice;
      }
    }
    return seeded;
  });
}, [motions]);
```

This ensures:
- Already-voted motions show their original choice in the locked card.
- New unvoted motions start with no choice (interactive).
- If the voter somehow has a choice already in state (e.g., from a prior interaction in the same mount), that is preserved.

The `readOnly` prop on `MotionCard` is already derived correctly via `isMotionReadOnly`:

```ts
const isMotionReadOnly = (m: { already_voted: boolean }) =>
  m.already_voted && !hasUnsubmittedSelected;
```

No change to `MotionCard.tsx` is needed — it already renders the correct locked state when `readOnly={true}` and displays the selected choice via `selected={choice === c}`.

### 3. No changes to `MotionCard.tsx`

The component already handles the `readOnly` prop correctly: it renders the "Already voted" badge and disables all vote buttons. With `choice` now pre-populated from `submitted_choice`, the voter's original selection will be visually highlighted in the locked card.

---

## Key Design Decisions

### Decision 1: Add `submitted_choice` to the existing `MotionOut` response rather than a separate endpoint

**Why:** The `GET /api/general-meeting/{id}/motions` response is already fetched by `VotingPage` on mount. Adding `submitted_choice` to this response avoids a second round-trip. The data is already available in the same query (the existing votes query just needs to return the choice column). A separate `GET .../my-votes` endpoint would add latency and complexity with no benefit.

**Alternative considered:** A new `GET /api/general-meeting/{id}/my-votes` endpoint returning a mapping of `motion_id → choice`. Rejected because the existing motions endpoint is the natural place for per-motion voter state, and the additional HTTP request is unnecessary.

### Decision 2: Prefer non-`not_eligible` choice in multi-lot scenarios

**Why:** `not_eligible` is a system-generated value, not a voter's intent. When displaying a locked card, the voter expects to see what they clicked, not a system classification. For a multi-lot voter where one lot had `not_eligible` recorded (in-arrear general motion) and another had `yes`, the card should show `yes`.

### Decision 3: Do not change `submit_ballot` backend logic

**Why:** The backend already correctly skips already-voted motions (lines 311–313 in `voting_service.py`). Even if the frontend sends `choices` for previously-voted motions (which it will, since `choices` is now pre-populated), those entries are silently ignored. No hardening is required.

### Decision 4: Seed `choices` via `useEffect` on motions load, not in `useState` initialiser

**Why:** `motions` is fetched asynchronously. The initialiser runs synchronously before the data arrives. A `useEffect` on `motions` runs after the data is available and correctly handles the async timing. The guard `!(m.id in seeded)` ensures subsequent re-renders or motion refetches do not overwrite user interactions.

---

## Data Flow (Happy Path)

1. **Voter re-authenticates.** `POST /api/auth/verify` returns `already_submitted: false` for their lot (because motion 4 is now visible and unvoted). `unvoted_visible_count: 4`. `AuthPage` routes to `/vote/{meetingId}/voting`.

2. **VotingPage mounts.** `choices` is initialised as `{}`.

3. **Motions query fires.** `GET /api/general-meeting/{id}/motions` returns 4 motions:
   - Motion 1: `already_voted: true`, `submitted_choice: "yes"`
   - Motion 2: `already_voted: true`, `submitted_choice: "no"`
   - Motion 3: `already_voted: true`, `submitted_choice: "abstained"`
   - Motion 4: `already_voted: false`, `submitted_choice: null`

4. **`useEffect` on `motions` fires.** Seeds `choices` with `{ [m1.id]: "yes", [m2.id]: "no", [m3.id]: "abstained" }`. Motion 4 is not seeded.

5. **`isMotionReadOnly` evaluation.** `hasUnsubmittedSelected` is `true` (at least one lot is unsubmitted). So `isMotionReadOnly` returns `false` for all motions — they would all be interactive.

   **Wait — this is a problem.** See note below.

### Important subtlety: `isMotionReadOnly` and `hasUnsubmittedSelected`

The current logic:

```ts
const hasUnsubmittedSelected = selectedLots.some((l) => !l.already_submitted);
const isMotionReadOnly = (m: { already_voted: boolean }) =>
  m.already_voted && !hasUnsubmittedSelected;
```

This was designed for the case where motions should be locked only when ALL lots are already submitted. When any unsubmitted lot is selected, all motions become interactive — even already-voted ones — because the voter needs to vote for the unsubmitted lot on those same motions.

**For the revote scenario this is actually the correct semantic.** When a voter has one lot, and that lot is now in the "partially submitted" state (submitted on motions 1–3, not yet submitted on motion 4), the lot's `already_submitted` flag is `false` (correctly — because it hasn't voted on motion 4 yet). Therefore `hasUnsubmittedSelected` is `true`, and `isMotionReadOnly` returns `false` for ALL motions — meaning motions 1, 2, and 3 are also interactive.

**This is the correct UX for the revote scenario.** The voter needs to confirm their choices for motions 1–3 as part of submitting motion 4. The submit endpoint will simply skip the already-voted motions (the `already_voted_by_lot` skip logic). The voter is effectively reconfirming their earlier choices as part of a "complete ballot for all visible motions" submission.

**However**, with `choices` now pre-populated from `submitted_choice`, the voter sees their original answers pre-filled in the interactive cards. They can change them if they want — but whatever they submit for already-voted motions will be silently ignored by the backend. This is the intended and acceptable behaviour.

**Revised flow step 5:**
- Motions 1, 2, 3 are shown as interactive (not read-only) but with choices pre-populated from `submitted_choice` (`yes`, `no`, `abstained`).
- Motion 4 is shown as interactive with no pre-selected choice.
- Progress bar counts 1 unanswered (motion 4). The voter only needs to answer motion 4 to submit.
- On submit, the backend skips motions 1–3 (already voted) and records motion 4.

This is the correct and expected UX. The voter can see what they previously voted, cannot accidentally blank out those answers (the choices are pre-populated), and only needs to answer the new motion.

**Note on `readOnly` badge:** With this new behaviour, the "Already voted" badge (rendered when `readOnly={true}`) would NOT appear on motions 1–3 in the revote scenario because `isMotionReadOnly` returns `false`. This is actually correct — those motions ARE interactive (the voter is selecting votes for all motions as part of the new submission). The pre-populated choices serve as a reminder of their prior vote, not a locked readonly display.

---

## Phase 2 — Motion locking (BUG-RV-03)

### Overview

After BUG-RV-02 is implemented (Phase 1 above), the voter in the revote scenario correctly sees their pre-populated prior choices on motions 1–3 and can answer motion 4. However, Phase 1 does NOT lock motions 1–3. The current `isMotionReadOnly` logic returns `false` for all motions when any selected lot has `already_submitted: false` — so motions 1–3 remain fully interactive, allowing the voter to change their prior answers (though the backend silently ignores those changes).

This is the gap described in BUG-RV-03. The user expectation is: **previously-voted motions should be locked/disabled and clearly show their submitted answer. Only newly visible unvoted motions should be interactive.**

### Investigation findings

After reading the code:

**`VotingPage.tsx` — `isMotionReadOnly` (line 237):**

```ts
const hasUnsubmittedSelected = selectedLots.some((l) => !l.already_submitted);
const isMotionReadOnly = (m: { already_voted: boolean }) =>
  m.already_voted && !hasUnsubmittedSelected;
```

This function locks a motion only when `already_voted === true` AND there are no unsubmitted lots selected. In the revote scenario, `hasUnsubmittedSelected` is `true` (the lot has `already_submitted: false` because it hasn't voted on motion 4 yet), so `isMotionReadOnly` returns `false` for ALL motions — even ones that have `already_voted: true`. Motions 1–3 are fully interactive.

**`MotionCard.tsx` — read-only visual state (lines 48–52):**

```tsx
{readOnly && (
  <span className="motion-card__voted-badge" aria-label="Already voted">
    Already voted
  </span>
)}
```

The component already has a complete read-only visual state: "Already voted" badge on the card header, all vote buttons disabled (via `isEffectivelyDisabled = disabled || readOnly`). The existing `motion-card--read-only` CSS class is applied when `readOnly={true}`. No new visual state needs to be added to `MotionCard.tsx`.

**`voter.ts` — `MotionOut` type:** Does NOT yet have `submitted_choice` (this is added in Phase 1/BUG-RV-02). Phase 2 depends on Phase 1 being complete.

### Root cause

`isMotionReadOnly` uses a per-lot (`hasUnsubmittedSelected`) condition as a proxy for per-motion state. The per-lot condition was designed for the "all lots submitted" case, not for the revote case where some motions are already voted but others are not.

The correct locking condition is per-motion, not per-lot:
- A motion should be read-only when `motion.already_voted === true` **regardless** of whether any selected lot is unsubmitted.

### Design

The `isMotionReadOnly` function (in `VotingPage.tsx`, line 237) must be changed from a per-lot condition to a per-motion condition.

**Current logic (line 237–238):**

```ts
const hasUnsubmittedSelected = selectedLots.some((l) => !l.already_submitted);
const isMotionReadOnly = (m: { already_voted: boolean }) =>
  m.already_voted && !hasUnsubmittedSelected;
```

**New logic:**

```ts
const isMotionReadOnly = (m: { already_voted: boolean }) => m.already_voted;
```

This is a one-line change. `hasUnsubmittedSelected` is no longer needed for `isMotionReadOnly` (it may still be needed elsewhere — see notes below).

### Impact on progress bar and submit button

The progress bar and submit button currently use `unvotedMotions`:

```ts
const unvotedMotions = motions ? motions.filter((m) => !isMotionReadOnly(m)) : [];
const answeredCount = unvotedMotions.filter((m) => !!choices[m.id]).length;
```

With the new `isMotionReadOnly` logic, `unvotedMotions` correctly contains only motions that are NOT yet voted (i.e., `already_voted === false`). The progress bar will show only the count of newly unvoted motions — exactly the correct behaviour.

The submit button visibility condition (`unvotedMotions.length > 0 && !isClosed`) is unchanged and correct: if there are new unvoted motions, the submit button appears.

### Impact on `hasUnsubmittedSelected`

After this change, `hasUnsubmittedSelected` is used only for the in-arrear warning banner calculation (via `selectedLots`). Verify that no other logic depends on it being used inside `isMotionReadOnly`. After the change, `hasUnsubmittedSelected` can be retained for the arrear banner and can be removed from the `isMotionReadOnly` closure.

### Impact on multi-lot voters

For a multi-lot voter where Lot A has submitted motions 1–3 and Lot B has not yet submitted anything:
- Before the fix: all motions are interactive for both lots (correct for Lot B, but motions 1–3 are now locked for Lot A's perspective — but since both lots share the same session, the voter still needs to answer motions 1–3 on behalf of Lot B).
- After the fix: motions 1–3 would be locked if `already_voted === true`. But `already_voted` is computed for the voter's session across ALL their lots. If Lot B has not yet voted on motions 1–3, then `already_voted` for motions 1–3 would be `false` (because there exists at least one lot for this voter without a submitted vote on those motions).

**This means the new lock condition `m.already_voted === true` is only `true` for motions where ALL of the voter's lots have voted.** This is exactly the correct semantics: a motion is fully voted when every lot in the session has a submitted vote row for it. The backend `list_motions` endpoint already computes `already_voted` this way (using `Vote.lot_owner_id.in_(all_lot_owner_ids)`).

For the single-lot revote case: `already_voted === true` on motions 1–3 (Lot's vote exists), `already_voted === false` on motion 4 (no vote yet). The lock applies correctly.

For the multi-lot case where only Lot A voted motions 1–3: `already_voted === false` for motions 1–3 (Lot B has no vote row), so they remain interactive — correct, because Lot B still needs to vote on them.

### Backend changes

None. The `already_voted` field in `MotionOut` already correctly represents "has every lot in this voter's session voted on this motion?".

### Frontend changes — `VotingPage.tsx` only

**File:** `frontend/src/pages/vote/VotingPage.tsx`

**Change:** Replace the `isMotionReadOnly` definition from:

```ts
const hasUnsubmittedSelected = selectedLots.some((l) => !l.already_submitted);
const isMotionReadOnly = (m: { already_voted: boolean }) =>
  m.already_voted && !hasUnsubmittedSelected;
```

To:

```ts
const isMotionReadOnly = (m: { already_voted: boolean }) => m.already_voted;
```

`hasUnsubmittedSelected` may be retained if it is used elsewhere in the component. On review of `VotingPage.tsx`, `hasUnsubmittedSelected` is defined at line 236 and used only inside `isMotionReadOnly`. Once that usage is removed it becomes dead code and should be removed.

**No changes to `MotionCard.tsx`** — the read-only visual state (`motion-card--read-only`, "Already voted" badge, disabled vote buttons) is already fully implemented and correct.

**No changes to `voter.ts`** — Phase 2 adds no new fields; it depends on `submitted_choice` from Phase 1.

### Key design decisions for Phase 2

**Decision: Lock per-motion (`m.already_voted`), not per-lot (`hasUnsubmittedSelected`).**

The old condition `m.already_voted && !hasUnsubmittedSelected` was a workaround: it intended to keep motions interactive for multi-lot voters who still had unsubmitted lots. But it was too broad — it kept ALL motions interactive, even ones already voted on by every lot in the session. The per-motion `m.already_voted` check is both simpler and correct for all cases.

**The revote submit flow remains unchanged.** The backend already skips already-voted motions (`already_voted_by_lot` check in `submit_ballot`). Locking the UI for those motions is purely a UX improvement — the backend behaviour is unchanged.

---

## Phase 3 — Per-lot per-motion locking and mixed selection warning (BUG-RV-04 / BUG-RV-05)

### Overview

Phases 1 and 2 fix the single-lot revote case well: `already_voted` (aggregated across all of the voter's lots) drives locking, and the backend skips any already-voted motion. However, the current model has a gap for **multi-lot voters in a mixed-state revote scenario**:

- Lot A has already voted on motions 1–3.
- Lot B has NOT yet voted on anything.
- Admin makes motion 4 visible.
- Voter selects BOTH Lot A and Lot B to vote together.

Under the Phase 2 logic, `already_voted` for motions 1–3 is `false` (because Lot B has no vote row for them), so motions 1–3 remain interactive. This is correct — Lot B needs to vote on motions 1–3. The voter answers motions 1–3 and 4, submits. The backend records motions 1–3 for Lot B and motion 4 for both lots; it silently skips motions 1–3 for Lot A.

The problem: **the voter is not informed that previously-voted motions for Lot A will not be re-recorded**. They may believe their new answers for motions 1–3 override Lot A's earlier vote — they do not. The new requirements address this with:

1. **Per-lot per-motion vote status** — knowing which specific lots have voted on which specific motions, to power both the locking decision and the warning.
2. **Mixed selection warning** — a dialog shown when the voter proceeds from lot selection to voting, if their selected lots have different prior-vote coverage.

### Requirement BUG-RV-04: Per-lot per-motion vote status

#### Data available

The backend `auth.py` already computes `voted_motion_ids_by_lot: dict[uuid.UUID, set[uuid.UUID]]` — a mapping of `{lot_owner_id: set_of_voted_motion_ids}` — for the purpose of computing `already_submitted` per lot. This data is not currently returned to the frontend.

The `LotInfo` schema currently contains:

```python
class LotInfo(BaseModel):
    lot_owner_id: uuid.UUID
    lot_number: str
    financial_position: str
    already_submitted: bool
    is_proxy: bool = False
```

#### Option evaluation

**Option A — Augment `MotionOut`: add `voted_lot_ids: list[uuid.UUID]`**

The motions endpoint (`GET /general-meeting/{id}/motions`) returns `MotionOut` per motion. Adding `voted_lot_ids` would list which lot_owner_ids have a submitted vote for each motion.

Frontend would compute: `isMotionReadOnlyForLot(m, lot) = m.voted_lot_ids.includes(lot.lot_owner_id)`.

Downsides:
- Returns all lot_owner_ids for all of the voter's lots on every motion — this is a list that the frontend already knows (from `allLots`). It is redundant information placed in the wrong conceptual layer (motion data carrying lot-membership data).
- Increases response payload per motion.
- The motions endpoint is called once on VotingPage mount. It does not carry lot selection state, making it awkward for the frontend to derive the "mixed selection" condition without cross-referencing two data sources (motions + allLots).

**Option B — Augment `LotInfo` in auth response: add `voted_motion_ids: list[uuid.UUID]`**

Add to `LotInfo` the list of motion IDs that this specific lot has already voted on (submitted votes only).

Frontend would compute:
- `isMotionVotedByLot(m, lot) = lot.voted_motion_ids.includes(m.id)` — whether this lot has voted this motion.
- `isMotionReadOnly(m) = selectedLots.every(lot => lot.voted_motion_ids.includes(m.id))` — a motion is locked when EVERY selected lot has voted on it. If some lots have voted and some haven't, the motion remains interactive.
- Mixed selection condition: any two selected lots have different `voted_motion_ids` sets — detected by comparing sets for equality across all selected lots.

Upsides:
- The auth response already computes this data in `voted_motion_ids_by_lot` — it is a trivial addition to each `LotInfo` construction.
- `LotInfo` is persisted to `sessionStorage` (`meeting_lots_info_{meetingId}`), so the per-lot vote status survives page reloads without an extra API call.
- The mixed-selection warning logic lives entirely in the frontend, using data already in hand.
- The motions endpoint and `MotionOut` are unchanged (no payload change for the common path).
- Works correctly for `restore_session` as well, since it runs the same `voted_motion_ids_by_lot` logic.

Downsides:
- `voted_motion_ids` in `LotInfo` can become stale after a submission. This is acceptable: after submission the voter navigates to the confirmation page and must re-authenticate before voting again, which always refreshes sessionStorage. See Decision 8.

**Option C — Separate endpoint: `GET /api/agm/{id}/my-votes`**

Returns `{ lot_owner_id: [motion_id, ...] }` for all of the voter's lots.

Downsides:
- Extra HTTP round-trip on VotingPage mount.
- Requires a new endpoint, new route, new schema.
- Data is available on the auth response — a separate endpoint is unnecessary complexity.

#### Recommendation: Option B

Option B requires the fewest changes (add one field to `LotInfo` schema + populate it in both `verify_auth` and `restore_session`), fits the existing auth/session data flow, and keeps `MotionOut` unchanged. The data is already computed in `voted_motion_ids_by_lot` — it only needs to be exposed in the response.

#### Backend changes for Option B

**File:** `backend/app/schemas/auth.py`

Add `voted_motion_ids` to `LotInfo`:

```python
class LotInfo(BaseModel):
    lot_owner_id: uuid.UUID
    lot_number: str
    financial_position: str
    already_submitted: bool
    is_proxy: bool = False
    voted_motion_ids: list[uuid.UUID] = []   # NEW — motion IDs with submitted votes for this lot
```

**File:** `backend/app/routers/auth.py`

In both `verify_auth` (step 10) and `restore_session` (step 9), the `voted_for_this_lot` set is already computed. Pass it when constructing `LotInfo`:

```python
voted_for_this_lot = voted_motion_ids_by_lot.get(lot_owner_id, set())
already_submitted = (
    len(visible_motion_ids) > 0
    and visible_motion_ids.issubset(voted_for_this_lot)
)
lots.append(LotInfo(
    lot_owner_id=lo.id,
    lot_number=lo.lot_number,
    financial_position=fp.value if hasattr(fp, "value") else fp,
    already_submitted=already_submitted,
    is_proxy=is_proxy,
    voted_motion_ids=list(voted_for_this_lot),   # NEW
))
```

This change is backward-compatible: `voted_motion_ids` defaults to `[]` and is ignored by existing clients.

#### Frontend changes for Option B

**File:** `frontend/src/api/voter.ts`

Add `voted_motion_ids` to `LotInfo`:

```ts
export interface LotInfo {
  lot_owner_id: string;
  lot_number: string;
  financial_position: string;
  already_submitted: boolean;
  is_proxy: boolean;
  voted_motion_ids: string[];   // NEW — motion IDs with submitted votes for this lot
}
```

**File:** `frontend/src/pages/vote/VotingPage.tsx`

Replace the Phase 2 `isMotionReadOnly` with a per-lot-per-motion version:

```ts
// A motion is read-only when every currently-selected lot has already voted on it.
// If any selected lot has not yet voted on this motion, it remains interactive.
const isMotionReadOnly = (m: { id: string; already_voted: boolean }) =>
  selectedLots.length > 0 &&
  selectedLots.every((lot) => lot.voted_motion_ids.includes(m.id));
```

Notes:
- `already_voted` (the aggregated flag from `MotionOut`) is no longer needed for the locking decision and can be dropped from `isMotionReadOnly`'s type constraint. It is still used by the `choices` seeding `useEffect` (Phase 1).
- When `selectedLots` is empty (voter has deselected all lots), `isMotionReadOnly` returns `false` for all motions, making them all interactive. This is consistent: there is nothing to lock when no lots are selected.
- The existing `unvotedMotions` derivation (`motions.filter(m => !isMotionReadOnly(m))`) correctly reflects the new per-lot locking, so the progress bar and submit button remain correct.

**Pre-population of choices** (from Phase 1) applies only when `m.already_voted === true` — that is, when every one of the voter's lots has voted on this motion. In the multi-lot mixed scenario, `already_voted` is `false` for motions where even one lot has not yet voted, so those motions are NOT pre-populated. Fresh lots always see blank cards. This is the correct UX: the voter must explicitly enter choices on behalf of the fresh lots. The `submitted_choice` field on `MotionOut` is still used for the single-lot revote case (where `already_voted === true`) and is not repurposed for per-lot pre-filling.

---

### Requirement BUG-RV-05: Mixed selection warning

#### What triggers the warning

When the voter clicks "Submit ballot" (in `handleSubmitClick`), before showing the existing `SubmitDialog`, check whether the selected lots have **mixed voting status** on visible motions.

A mixed state exists when **any two selected lots have different `voted_motion_ids` sets**. Concretely:

```ts
function hasMixedVoteStatus(selectedLots: LotInfo[]): boolean {
  if (selectedLots.length <= 1) return false;
  const first = new Set(selectedLots[0].voted_motion_ids);
  return selectedLots.slice(1).some((lot) => {
    const s = new Set(lot.voted_motion_ids);
    return (
      s.size !== first.size ||
      [...s].some((id) => !first.has(id))
    );
  });
}
```

This is strictly correct: it fires whenever lots have voted on different subsets of motions, not only when some are completely fresh. Examples of when the warning fires:
- Lot A has voted on motions 1–3; Lot B has not voted at all.
- Lot A has voted on motions 1–2; Lot B has voted on motions 1–3 (different coverage).

The warning does NOT fire when:
- Only one lot is selected (single-lot scenario — no ambiguity).
- All selected lots have identical `voted_motion_ids` sets (including when all are completely empty — all fresh).
- All selected lots have the same partial coverage (e.g., both voted motions 1–2 but not 3).

A lot whose `voted_motion_ids` set differs from any other selected lot is considered a "differing lot" and is listed by lot number in the warning dialog. In the component props, rename the prop from `partiallyVotedLotNumbers` to `differingLotNumbers` to reflect this more precise semantics.

#### Warning dialog design

A new `MixedSelectionWarningDialog` component is shown between "Submit ballot" click and the existing `SubmitDialog`.

**State:** Add `showMixedWarning: boolean` to `VotingPage` state.

**Flow:**
1. Voter clicks "Submit ballot".
2. `handleSubmitClick` checks for mixed selection.
3. If mixed: set `showMixedWarning = true`. Do NOT proceed to `SubmitDialog` yet.
4. Voter clicks "Continue" in `MixedSelectionWarningDialog`: hide warning dialog, proceed to `SubmitDialog` as normal (set `showDialog = true`, set `highlightUnanswered = true`).
5. Voter clicks "Go back" in `MixedSelectionWarningDialog`: hide warning dialog, return to lot selection (no navigation needed — the lot panel is already visible in the sidebar).

**Message text:**

> "The lots you have selected have different voting histories — some have already voted on certain motions while others have not.
>
> Previously recorded votes are fixed and will not be changed. For each lot, only motions it has not yet voted on will be recorded from this submission.
>
> Lots with differing vote histories: **[lot number list]**
>
> Do you want to continue?"

The lot number list is rendered as a comma-separated inline list of lot numbers drawn from `differingLotNumbers`.

**Actions:**
- "Continue" — proceed to SubmitDialog
- "Go back to lot selection" — dismiss warning, return focus to lot panel

#### Placement: VotingPage (not lot selection screen)

The warning is shown from `VotingPage.handleSubmitClick` rather than from the lot-selection screen (`AuthPage`), because:
- The lot selection screen (`AuthPage`) does not have motion data loaded yet — it cannot know which motions are "new" vs "already voted per lot" without an extra API call.
- By the time the voter is on VotingPage, both `motions` (with `already_voted` and `submitted_choice` per motion) and `allLots` (with `voted_motion_ids` per lot) are in state. The mixed-selection condition can be computed locally without any network round-trip.
- The voter may change their lot selection multiple times before submitting. Showing the warning at submit time (rather than at lot-selection time) avoids repeated interruptions.

#### New component: `MixedSelectionWarningDialog`

**File:** `frontend/src/components/vote/MixedSelectionWarningDialog.tsx`

Props:
```ts
interface MixedSelectionWarningDialogProps {
  differingLotNumbers: string[];   // lot_number values for lots whose voted_motion_ids differ from at least one other selected lot
  onContinue: () => void;
  onGoBack: () => void;
}
```

Renders a modal overlay (same pattern as `SubmitDialog`). Shows the warning message with the inline lot number list drawn from `differingLotNumbers` so the voter understands exactly which lots have different voting histories.

#### Frontend changes summary

**Files changed:**

| File | Change |
|---|---|
| `frontend/src/api/voter.ts` | Add `voted_motion_ids: string[]` to `LotInfo` |
| `frontend/src/pages/vote/VotingPage.tsx` | Replace `isMotionReadOnly` with per-lot version; add `showMixedWarning` state; add mixed-check in `handleSubmitClick`; render `MixedSelectionWarningDialog` |
| `frontend/src/components/vote/MixedSelectionWarningDialog.tsx` | New component — modal warning dialog |

#### Backend changes summary

**Files changed:**

| File | Change |
|---|---|
| `backend/app/schemas/auth.py` | Add `voted_motion_ids: list[uuid.UUID] = []` to `LotInfo` |
| `backend/app/routers/auth.py` | Populate `voted_motion_ids` in both `verify_auth` and `restore_session` |

No new endpoints. No schema migration. No changes to `MotionOut`, `voting.py` routes, or any service files.

---

### Key design decisions for Phase 3

**Decision 1: Option B (augment `LotInfo` in auth response) over Options A and C.**

The data is already computed in `voted_motion_ids_by_lot` during both `verify_auth` and `restore_session`. Adding it to `LotInfo` requires two trivial additions in `auth.py` and one field in the schema. The `LotInfo` objects are already persisted to `sessionStorage` on every auth, so the per-lot vote status is available without an extra round-trip on VotingPage mount.

**Decision 2: `isMotionReadOnly` locks when ALL selected lots have voted, not when ANY has voted.**

If any selected lot has not yet voted on a motion, that motion must remain interactive — otherwise the voter cannot submit for that lot. The "all selected lots have voted" condition is the minimum threshold for safely locking. This is a natural extension of the Phase 2 `m.already_voted` condition: `already_voted` is `true` only when all of the voter's lots have voted; the new per-selection version applies the same logic scoped to currently-selected lots.

**Decision 3: Mixed warning triggers when any two selected lots have different `voted_motion_ids` sets (stricter condition).**

The simpler "fresh vs partial" check would miss a real case: Lot A voted motions 1–2 and Lot B voted motions 1–3 — both are "partial" but have different coverage. If the warning only fired for fresh-vs-partial, the voter would submit without knowing that Lot A's motion-3 answer will not be recorded (it was already submitted). The stricter set-equality check fires in this case. The warning is suppressed only when all selected lots have identical `voted_motion_ids` sets (including the all-empty case — all fresh first-time voters). This minimises false positives while covering all real ambiguous cases.

**Decision 4: Warning fires at submit time, not at lot-selection time.**

The lot-selection panel is inline in `VotingPage` (sidebar). The voter can freely toggle lots before submitting. Warning at submit time is non-disruptive for lot toggles, and is the right moment to inform the voter before they commit. Showing the warning at lot-selection time would require passing motion data into the sidebar, coupling two concerns that are currently cleanly separated.

**Decision 5: Warning message does not say "your prior votes are wrong" — it says they will not be changed.**

The tone is neutral and informational. The voter's prior votes are correct by definition (they submitted them). The warning clarifies what will happen, not that something is wrong. This avoids alarming voters.

**Decision 6: `voted_motion_ids` in `LotInfo` contains all submitted vote rows for the lot (not filtered to visible motions).**

The `voted_motion_ids_by_lot` map in `auth.py` is filtered by `Vote.general_meeting_id` and `Vote.status == submitted`, but not by `Motion.is_visible`. This is correct for the warning trigger: a lot that has voted on a hidden motion still has a different `voted_motion_ids` set from one that has not — the admin could re-show that motion at any time. The frontend uses `voted_motion_ids` only for locking and warning decisions against the currently-returned motion list from `GET /motions`, so hidden motions in the set have no visible effect unless the admin re-shows them (at which point the voter re-authenticates and gets a refreshed set).

**Decision 7: Fresh lots always see blank cards — no per-lot pre-filling from another lot's `submitted_choice`.**

Pre-population (from Phase 1) is gated on `m.already_voted === true`, which is only true when every lot in the voter's session has voted on that motion. When any lot is fresh, `already_voted` is `false` and the motion card starts blank. This is intentional: showing Lot A's prior answer as a suggestion for Lot B would mislead the voter into thinking Lot B has already voted, and would make it less obvious that they must actively confirm choices for Lot B. The voter enters choices explicitly, making the submission deliberate for the fresh lot.

**Decision 8: Staleness of `voted_motion_ids` in sessionStorage is acceptable.**

After a successful submission the voter is navigated to the confirmation page. To vote again (e.g., a new motion is made visible) the voter must re-authenticate, which always rewrites the `LotInfo[]` (including `voted_motion_ids`) in sessionStorage. A lot whose `already_submitted` flag becomes `true` after a submission is excluded from selection on the next visit to the lot panel, so its stale `voted_motion_ids` is never read in a decision context. No mid-session refresh of `voted_motion_ids` is required.

---

### Data flow — Phase 3 happy path (multi-lot mixed revote)

1. **Setup:** Meeting has motions 1–3 visible. Voter has Lot A and Lot B. Voter authenticated previously, submitted votes for Lot A on motions 1–3. Lot B never voted.

2. **Admin makes motion 4 visible.** Lot A: `already_submitted = false` (motion 4 unvoted). Lot B: `already_submitted = false` (all motions unvoted).

3. **Voter authenticates.** `POST /api/auth/verify` returns:
   - Lot A: `already_submitted: false`, `voted_motion_ids: [m1, m2, m3]`
   - Lot B: `already_submitted: false`, `voted_motion_ids: []`
   - `unvoted_visible_count: 4` (because at least one lot is unsubmitted)

4. **`AuthPage.handleAuthSuccess`** writes `LotInfo[]` (including `voted_motion_ids`) to `sessionStorage`. Routes to VotingPage.

5. **VotingPage mounts.** Reads `LotInfo[]` from sessionStorage. Default selection = pending lots = [Lot A, Lot B] (both unsubmitted).

6. **Motions query fires.** Returns 4 motions:
   - Motions 1–3: `already_voted: false` (Lot B has no votes), `submitted_choice: "yes"/"no"/"abstained"` (from Lot A's votes, via `voted_choice_by_motion` in `list_motions`)
   - Motion 4: `already_voted: false`, `submitted_choice: null`

   Note: `submitted_choice` is still populated for motions 1–3 because the `list_motions` endpoint fetches from ALL of the voter's lots regardless of selection.

7. **`isMotionReadOnly` evaluation** (per-lot version):
   - Motion 1: Lot A has voted (m1 in voted_motion_ids), Lot B has not → NOT all selected lots voted → `false` (interactive)
   - Motion 2: same → `false`
   - Motion 3: same → `false`
   - Motion 4: neither lot has voted → `false`
   - All motions remain interactive.

8. **`choices` seeding** (`useEffect` on `motions`): Motions 1–3 have `already_voted: false` (Lot B has not yet voted on them), so the Phase 1 seeding guard `m.already_voted && m.submitted_choice !== null` does not trigger. Motion 4 also has no prior vote. All choices start empty. The voter must answer all 4 motions from scratch on behalf of Lot B. This is intentional — fresh lots always see blank cards, even though `submitted_choice` may be non-null on `MotionOut` (populated from Lot A's prior votes by the backend). Showing Lot A's answer as a pre-fill for Lot B would mislead the voter and make the submission feel less deliberate for the fresh lot.

9. **Voter answers motions 1–4.** Clicks "Submit ballot".

10. **`handleSubmitClick` mixed-selection check:**
    - Lot A has `voted_motion_ids: [m1, m2, m3]`.
    - Lot B has `voted_motion_ids: []`.
    - Sets differ → `hasMixedVoteStatus` returns `true`. `showMixedWarning = true`.

11. **`MixedSelectionWarningDialog` shown.** `differingLotNumbers` contains both lot numbers (both differ from each other). Warning message names both lots. Voter reads the warning, clicks "Continue".

12. **Proceeds to `SubmitDialog`** as normal (`showDialog = true`). Voter confirms.

13. **Submit fires.** Backend receives `lot_owner_ids: [Lot A id, Lot B id]` and `votes: [{m1, "yes"}, {m2, "no"}, {m3, "abstained"}, {m4, "for"}]`.

14. **Backend `submit_ballot`:** For Lot A, skips motions 1–3 (already voted); records motion 4. For Lot B, records all 4 motions. Returns success.

15. **Voter navigates to confirmation page.** Lot A and Lot B both show all 4 motions with correct choices.

---

### Phase 3 schema migration note

No Alembic migration is required. All changes are in application code (schema + router for backend, TypeScript types + components for frontend). No new columns, tables, or enum values.

---

## Vertical Slice Analysis

This change is a single small vertical slice touching:
- One backend schema file (`voting.py` in schemas) — Phase 1
- One backend router/endpoint (`voting.py` in routers) — Phase 1
- One frontend type file (`voter.ts`) — Phase 1
- One frontend page (`VotingPage.tsx`) — Phase 1 + Phase 2
- One backend schema file (`auth.py` in schemas) — Phase 3
- One backend router (`auth.py` in routers) — Phase 3
- One new frontend component (`MixedSelectionWarningDialog.tsx`) — Phase 3
- Updated frontend page (`VotingPage.tsx`) — Phase 3

Phase 2 is a one-line change to `VotingPage.tsx` that depends on `submitted_choice` from Phase 1. Both phases should be implemented on the same branch.

Phase 3 depends on Phase 1 (for `voted_motion_ids` in `LotInfo` and `submitted_choice` in `MotionOut` to be consistent) but can be branched off the Phase 1+2 branch. All three phases should be implemented on a single branch given their tight interdependence.

---

## E2E Test Scenarios

### Happy path

**Scenario 1: Voter re-enters after new motion made visible — pre-populated choices and prior motions locked**

1. Seed: meeting with motions 1, 2, 3 (all visible). Lot owner authenticates and votes yes/no/abstained. Submits.
2. Admin makes motion 4 visible.
3. Voter authenticates again. Lands on voting page (not confirmation).
4. Assert: motions 1, 2, 3 are shown with their original choices pre-selected (yes/no/abstained).
5. Assert: motions 1, 2, 3 have the "Already voted" badge and disabled vote buttons (read-only state).
6. Assert: motion 4 has no pre-selected choice and interactive vote buttons.
7. Assert: progress bar shows 1 unanswered out of 1 newly-unvoted motion (motions 1–3 are excluded from the progress bar count).
8. Voter selects a choice for motion 4. Submits.
9. Assert: confirmation page shows all 4 motions with correct choices (1–3 from original, 4 from new vote).
10. Assert: voter re-authenticates again. Routes to confirmation page (all 4 motions submitted).

**Scenario 7 (Phase 3): Multi-lot mixed-state revote — warning shown, then successful submission**

1. Seed: meeting with motions 1–3 visible. Voter has Lot A and Lot B. Lot A has voted on motions 1–3 (yes/no/abstained). Lot B has not voted.
2. Admin makes motion 4 visible.
3. Voter authenticates. Both lots are unsubmitted (Lot A has not voted on motion 4; Lot B has not voted at all). Voter is routed to VotingPage.
4. Assert: auth response contains `voted_motion_ids: [m1, m2, m3]` for Lot A and `voted_motion_ids: []` for Lot B.
5. Assert: both Lot A and Lot B are available for selection in the lot panel (neither has `already_submitted: true`).
6. Assert: motions 1–3 are interactive (Lot B has not voted on them).
7. Assert: motion 4 is interactive with no pre-selected choice.
8. Assert: choices for motions 1–3 are NOT pre-populated (because `already_voted === false`).
9. Voter answers all 4 motions. Clicks "Submit ballot".
10. Assert: `MixedSelectionWarningDialog` is shown, listing Lot A as a partially-voted lot.
11. Voter clicks "Continue".
12. Assert: `SubmitDialog` is shown. Voter confirms.
13. Assert: backend records motions 1–3 for Lot B; skips motions 1–3 for Lot A; records motion 4 for both lots.
14. Assert: confirmation page shows both lots with all 4 motions, correct choices.

**Scenario 8 (Phase 3): Mixed warning — voter goes back to lot selection and deselects partially-voted lot**

1. Same setup as Scenario 7.
2. Voter answers motions 1–4. Clicks "Submit ballot".
3. `MixedSelectionWarningDialog` appears.
4. Voter clicks "Go back to lot selection".
5. Assert: dialog closes. Voter is back on VotingPage with lot panel visible.
6. Voter deselects Lot A (only Lot B is selected). Clicks "Submit ballot" again.
7. Assert: no mixed warning (only Lot B selected — it has `voted_motion_ids: []`).
8. Proceeds to `SubmitDialog`. Confirms. Backend records motions 1–4 for Lot B only.

### Error/edge cases

**Scenario 2: Voter attempts to change a previously-voted motion's choice**

In the post-Phase-2 UI, motions 1–3 are disabled. This scenario verifies that the original votes are preserved at the DB level regardless.

1. Seed: same as scenario 1, voter has submitted motions 1–3.
2. Admin makes motion 4 visible. Voter re-enters.
3. Assert: motions 1–3 are locked (disabled vote buttons, "Already voted" badge).
4. Voter answers motion 4 and submits.
5. Assert: vote record for motion 1 still shows `yes` (backend preserved it).
6. Assert: vote record for motion 4 shows the new choice.
7. Assert: confirmation page shows motion 1 as `yes` (original), motion 4 as the new choice.

**Scenario 3: No new motions — voter who has submitted all visible motions routes to confirmation**

1. Seed: meeting with motions 1, 2, 3. Voter submits all 3.
2. Voter re-authenticates with no new motions added.
3. Assert: voter is routed to confirmation page, not voting page.

**Scenario 4: Multi-lot voter — one lot fully submitted, one lot not (motions remain interactive)**

1. Seed: meeting with motions 1, 2, 3. Voter has two lots. Submits for Lot A only.
2. Admin makes motion 4 visible.
3. Voter re-authenticates.
4. Assert: `already_voted` for motions 1–3 is `false` (Lot B has not yet voted on them).
5. Assert: motions 1–3 are interactive (not read-only) — correct, Lot B needs to vote on them.
6. Assert: motion 4 is interactive with no pre-selected choice.
7. Voter selects both lots, answers all 4 motions, submits.
8. Assert: backend records motions 1–3 for Lot B and motion 4 for both lots; skips motions 1–3 for Lot A.

**Scenario 5: In-arrear lot — `not_eligible` not shown as pre-populated button selection**

1. Seed: meeting with 1 general motion. Lot in arrear. Voter submits — motion recorded as `not_eligible`.
2. Admin makes a second (special) motion visible.
3. Voter re-enters. Motions query returns general motion with `already_voted: true`, `submitted_choice: "not_eligible"`.
4. Assert: general motion is locked (read-only, "Already voted" badge). None of the Yes/No/Abstain buttons appears selected (because `not_eligible` is not one of the three button choices).
5. Voter answers special motion. Submits.
6. Assert: general motion still recorded as `not_eligible`. Special motion recorded correctly.

**Scenario 9 (Phase 3): All-fresh selection — no mixed warning shown**

1. Seed: meeting with motions 1–3. Voter has Lot A and Lot B. Neither lot has voted.
2. Voter authenticates. Selects both lots. Answers motions 1–3. Clicks "Submit ballot".
3. Assert: `MixedSelectionWarningDialog` is NOT shown.
4. Proceeds directly to `SubmitDialog`. Confirms. Both lots submit successfully.

**Scenario 10 (Phase 3): Identical partial coverage — no mixed warning shown**

1. Seed: meeting with motions 1–3. Voter has Lot A and Lot B. Both have voted on motions 1–2 but not motion 3.
2. Admin makes motion 3 visible (was hidden). Both lots' `voted_motion_ids` are `[m1, m2]` — identical.
3. Voter authenticates. Selects both lots. Answers motion 3. Clicks "Submit ballot".
4. Assert: `MixedSelectionWarningDialog` is NOT shown (`voted_motion_ids` sets are equal — no mixed state).
5. Proceeds to `SubmitDialog`. Confirms. Both lots record motion 3.

**Scenario 11 (Phase 3): Differing partial coverage — warning shown even though both lots are "partial"**

1. Seed: meeting with motions 1–3. Voter has Lot A and Lot B. Lot A has voted on motions 1–2. Lot B has voted on motions 1–3. Both lots are unsubmitted because motion 4 (not yet made visible) means `already_submitted` checks pass — actually use a simpler seed: Lot A voted motions 1–2; Lot B voted motions 1–3 and then a new motion 4 is made visible so neither `already_submitted` is true.
2. Voter authenticates. Auth returns Lot A: `voted_motion_ids: [m1, m2]`, Lot B: `voted_motion_ids: [m1, m2, m3]`.
3. Voter selects both lots. Answers motion 4 (only interactive unvoted motion). Clicks "Submit ballot".
4. Assert: `MixedSelectionWarningDialog` IS shown — the `voted_motion_ids` sets differ between Lot A and Lot B. Both lot numbers are listed in `differingLotNumbers`.
5. Voter clicks "Continue". Proceeds to `SubmitDialog`. Confirms.
6. Assert: backend records motion 4 for both lots; skips motions 1–2 for both lots; skips motion 3 for Lot B only.

### State-based scenarios

**Scenario 6: Meeting closed before voter can answer new motion**

1. Seed: voter has submitted motions 1–3. Admin makes motion 4 visible. Admin immediately closes meeting.
2. Voter re-authenticates. `agm_status: "closed"` — routes to confirmation page directly.
3. Assert: confirmation page shows only motions 1–3 (motion 4 has no submitted vote).

---

## Tests Required

### Backend unit/integration

1. `test_list_motions_includes_submitted_choice` — verify that `GET /motions` returns `submitted_choice` populated for already-voted motions and `null` for unvoted motions.
2. `test_list_motions_submitted_choice_prefers_non_not_eligible` — voter with two lots (one in-arrear), general motion voted: `not_eligible` for in-arrear lot, `yes` for normal lot. Assert `submitted_choice == "yes"`.
3. `test_list_motions_submitted_choice_null_when_not_voted` — new motion made visible after prior submission. New motion has `already_voted: false`, `submitted_choice: null`.
4. `test_submit_skips_already_voted_motions_with_inline_choices` — submit request includes a choice for a previously-voted motion; assert that the original vote row is unchanged and no duplicate row is created.
5. `test_auth_verify_lot_info_includes_voted_motion_ids` — (Phase 3) after a lot submits votes on motions 1–2, `POST /api/auth/verify` returns `voted_motion_ids: [m1_id, m2_id]` for that lot.
6. `test_auth_verify_lot_info_voted_motion_ids_empty_for_unvoted_lot` — (Phase 3) a lot that has never voted returns `voted_motion_ids: []`.
7. `test_restore_session_lot_info_includes_voted_motion_ids` — (Phase 3) same as test 5 but via `POST /api/auth/session`.
8. `test_auth_verify_voted_motion_ids_excludes_draft_votes` — (Phase 3) draft votes (status = draft) are not included in `voted_motion_ids`; only submitted votes.

### Frontend unit

1. `VotingPage` — when `motions` query resolves with `already_voted: true` and `submitted_choice: "yes"` on a motion, the `choices` state is seeded with `"yes"` for that motion ID.
2. `VotingPage` — when `motions` query resolves with `already_voted: false` and `submitted_choice: null`, the motion ID is not seeded in `choices`.
3. `VotingPage` — `choices` seeding does not overwrite an existing user interaction (if choice was already set before `motions` resolves).
4. `VotingPage` — `isMotionReadOnly` returns `true` for a motion when all selected lots include the motion ID in `voted_motion_ids`. (Phase 3)
5. `VotingPage` — `isMotionReadOnly` returns `false` for a motion when at least one selected lot does NOT include the motion ID in `voted_motion_ids`. (Phase 3)
6. `VotingPage` — `isMotionReadOnly` returns `false` when `selectedLots` is empty. (Phase 3 edge case)
7. `VotingPage` — mixed-selection warning fires when any two selected lots have different `voted_motion_ids` sets (e.g., one fresh and one partial). (Phase 3)
8. `VotingPage` — mixed-selection warning fires when both lots are partial but have different `voted_motion_ids` sets (e.g., Lot A voted m1–m2, Lot B voted m1–m3). (Phase 3)
9. `VotingPage` — mixed-selection warning does NOT fire when all selected lots have identical `voted_motion_ids` sets (including all-empty). (Phase 3)
10. `VotingPage` — mixed-selection warning does NOT fire when only one lot is selected. (Phase 3)
11. `MixedSelectionWarningDialog` — renders the warning message and lists the `differingLotNumbers` lot numbers. (Phase 3)
12. `MixedSelectionWarningDialog` — "Continue" callback fires when Continue button is clicked. (Phase 3)
13. `MixedSelectionWarningDialog` — "Go back" callback fires when Go back button is clicked. (Phase 3)
13. `MotionCard` — when `readOnly={false}` and `choice="yes"` is passed, the Yes button renders as selected.
14. `MotionCard` — when `readOnly={true}` and `choice="no"` is passed, the No button renders as selected and all buttons are disabled.
15. `MotionCard` — when `readOnly={true}`, the "Already voted" badge is rendered.
