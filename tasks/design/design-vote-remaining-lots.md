# Technical Design: Vote for Remaining Lots (ConfirmationPage Re-Entry)

## Overview

After a multi-lot voter submits a ballot for a subset of their lots, the ConfirmationPage shows a "Vote for remaining lots" button. Clicking it stores the unsubmitted lot IDs in `sessionStorage` and navigates directly to the VotingPage, bypassing re-authentication. A related but distinct flow uses `unvoted_visible_count` from the auth response to route voters back to the VotingPage when new motions have been revealed after their initial submission.

**Schema migration required: NO.**

---

## Feature: "Vote for remaining lots" button

### When the button appears

The button is rendered on `ConfirmationPage` when `data.remaining_lot_owner_ids.length > 0`.

`remaining_lot_owner_ids` is returned by `GET /api/general-meeting/{id}/my-ballot` and contains the IDs of lots belonging to the voter's email that do NOT yet have a `BallotSubmission` for this meeting. Computed in `voting_service.get_my_ballot`:

```python
remaining_lot_owner_ids = [lid for lid in all_lot_owner_ids if lid not in submitted_lot_ids]
```

`all_lot_owner_ids` = all lot owner IDs reachable from the voter's email (own lots + proxied lots). `submitted_lot_ids` = IDs of lots with an existing `BallotSubmission` for this meeting.

### What the button does

```tsx
<button
  className="btn btn--secondary"
  onClick={() => {
    sessionStorage.setItem(
      `meeting_lots_${meetingId}`,
      JSON.stringify(data.remaining_lot_owner_ids)
    );
    navigate(`/vote/${meetingId}/voting`);
  }}
>
  Vote for remaining lots
</button>
```

1. Overwrites `sessionStorage` key `meeting_lots_<meetingId>` with the array of remaining (unsubmitted) lot owner IDs.
2. Navigates to `/vote/<meetingId>/voting`.

The VotingPage reads `meeting_lots_<meetingId>` from `sessionStorage` to know which lots to submit on behalf of. Overwriting the key with only the remaining lot IDs ensures the VotingPage only submits votes for lots that have not yet submitted.

### Conditions where the button does NOT appear

- Single-lot voter whose lot already submitted: `remaining_lot_owner_ids` is empty.
- Multi-lot voter who has submitted all their lots: `remaining_lot_owner_ids` is empty.
- Meeting is closed: the voter is routed to the ConfirmationPage by `AuthPage` on re-entry, but `remaining_lot_owner_ids` reflects real submission state — it could still be non-empty if some lots never voted, though the meeting being closed means no new submissions can be accepted (VotingPage/submit will return 403 for closed meetings).

---

## Feature: `unvoted_visible_count` re-entry routing

This field is returned by `POST /api/auth/verify` and drives the `AuthPage` routing decision.

### `AuthVerifyResponse` interface — `frontend/src/api/voter.ts`

```typescript
export interface AuthVerifyResponse {
  lots: LotInfo[];
  voter_email: string;
  agm_status: string;
  building_name: string;
  meeting_title: string;
  unvoted_visible_count: number;
}
```

### `AuthPage` routing logic — `frontend/src/pages/vote/AuthPage.tsx`

After a successful `verifyAuth` call:

1. Write session data to `sessionStorage`:
   - `meeting_lots_<meetingId>`: pending (unsubmitted) lot IDs
   - `meeting_lots_info_<meetingId>`: full lot info array (including `is_proxy`)
   - `meeting_lot_info_<meetingId>`: pending lot info array (including `financial_position`)
   - `meeting_building_name_<meetingId>`: building name string
   - `meeting_title_<meetingId>`: meeting title string

2. Route based on status and remaining work:
   - `agm_status === "pending"` → navigate to `/` with pending message
   - `agm_status === "closed"` → navigate to `/vote/<meetingId>/confirmation`
   - `hasRemainingLots || data.unvoted_visible_count > 0` → navigate to `/vote/<meetingId>/voting`
   - Otherwise → navigate to `/vote/<meetingId>/confirmation`

`hasRemainingLots` is `data.lots.some(l => !l.already_submitted)`. This guards the edge case where `unvoted_visible_count` might be zero but a lot still hasn't submitted (belt-and-suspenders).

`unvoted_visible_count` is the server-authoritative count of visible motions that the voter has not yet cast a submitted vote for (across all their lots). It is the primary signal for routing a voter who has partially voted (e.g. voted in a first session, new motions revealed by admin, re-entering to vote on the new motions).

### Backend computation — `backend/app/routers/auth.py`

After resolving `all_lot_owner_ids` for the voter:

1. Fetch all `BallotSubmission` lot IDs for this voter in this meeting → `submitted_lot_ids`.
2. Compute `remaining_lot_owner_ids_set = all_lot_owner_ids - submitted_lot_ids`.
3. If `remaining_lot_owner_ids_set` is non-empty: all visible motions are unvoted from the perspective of at least one lot → `unvoted_visible_count = len(visible_motions)`.
4. If all lots have submitted: count visible motions where not all of the voter's lots have a submitted `Vote` record → this handles phased-reveal re-entry for already-submitted lots.
5. Return `unvoted_visible_count` in `AuthVerifyResponse`.

---

## Relationship to Motion Visibility Feature

The `unvoted_visible_count` field was introduced as part of the motion visibility (phased reveal) feature. Its purpose:

- Before motion visibility: `unvoted_visible_count` was simply a proxy for "has this voter submitted all their lots". The button existed independently (driven by `remaining_lot_owner_ids`).
- After motion visibility: `unvoted_visible_count` also handles the case where all lots have submitted but new motions have been revealed. A voter who submitted on all their lots but has new visible motions to vote on gets `unvoted_visible_count > 0` and is routed back to the VotingPage even though `hasRemainingLots` is `false`.

The two signals are complementary:
- `remaining_lot_owner_ids` → drives the "Vote for remaining lots" button on `ConfirmationPage` (lots that never submitted at all)
- `unvoted_visible_count` → drives `AuthPage` routing (combines both unsubmitted lots and newly revealed motions)

---

## Data Flow: Multi-Lot Voter

1. Voter with lots A and B authenticates. `lots` = `[{lot_owner_id: A, already_submitted: false}, {lot_owner_id: B, already_submitted: false}]`. `unvoted_visible_count = 3` (3 visible motions).
2. `AuthPage` routes to VotingPage. `meeting_lots_<id>` = `[A, B]`.
3. LotSelectionPage: voter selects lot A only.
4. VotingPage submits votes for lot A. `BallotSubmission` created for A.
5. `my-ballot` response: `submitted_lots = [A]`, `remaining_lot_owner_ids = [B]`.
6. ConfirmationPage shows "Vote for remaining lots" button.
7. Voter clicks button → `meeting_lots_<id>` overwritten with `[B]` → navigate to VotingPage.
8. VotingPage submits votes for lot B. `BallotSubmission` created for B.
9. `my-ballot` response: `submitted_lots = [A, B]`, `remaining_lot_owner_ids = []`.
10. ConfirmationPage: no "Vote for remaining lots" button.

---

## Files Involved

| File | Role |
|---|---|
| `frontend/src/pages/vote/ConfirmationPage.tsx` | Renders "Vote for remaining lots" button; reads `remaining_lot_owner_ids` from `my-ballot` response |
| `frontend/src/pages/vote/AuthPage.tsx` | Routing logic using `unvoted_visible_count` and `hasRemainingLots` |
| `frontend/src/api/voter.ts` | `AuthVerifyResponse.unvoted_visible_count`, `MyBallotResponse.remaining_lot_owner_ids` |
| `backend/app/routers/auth.py` | Computes and returns `unvoted_visible_count` |
| `backend/app/services/voting_service.py` | `get_my_ballot` computes `remaining_lot_owner_ids` |
| `backend/app/schemas/voting.py` | `MyBallotResponse.remaining_lot_owner_ids: list[uuid.UUID]` |
| `backend/app/schemas/auth.py` | `AuthVerifyResponse.unvoted_visible_count: int` (default 0) |
