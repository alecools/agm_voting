# Design: Voting Flow

## Overview

The voter flow is: authenticate (OTP) → lot selection → voting → confirmation. Proxy voters see "via Proxy" badges. Multi-lot voters have a sidebar for selecting which lot to vote for. Already-voted motions render read-only so voters can return after new motions are revealed without losing prior votes. The confirmation page shows all submitted votes. All flow components meet WCAG 2.1 AA accessibility requirements.

---

## Data Model

Key tables involved in the voting flow (schemas in `design-building-lot-management.md` and `design-motion-management.md`):

- `session_records` — created on successful auth; provides `voter_email`, `building_id`, `general_meeting_id`
- `votes` — one row per `(general_meeting_id, motion_id, lot_owner_id, motion_option_id?)` with `choice` and `status` (`draft` or `submitted`)
- `ballot_submissions` — one row per `(general_meeting_id, lot_owner_id)`; `submitted_at`, `voter_email`, `proxy_email` (audit), `is_absent`, `submitted_by_admin`

Unique constraint: `uq_votes_non_multi_choice` on `(gm_id, motion_id, lot_owner_id)` WHERE `motion_option_id IS NULL`.

---

## API Endpoints

### `GET /api/general-meeting/{id}/motions`

Requires session cookie.

Returns all visible motions (`is_visible = True`) PLUS any motions for which the voter has a submitted vote (even if now hidden). Each `MotionOut` includes:
- `already_voted: bool` — True if the voter has a submitted vote for this motion
- `is_visible: bool`
- `voting_closed_at: datetime | null`
- `options: list[MotionOptionOut]` — populated for multi-choice motions
- `submitted_option_choices: dict[str, str]` — populated for already-voted multi-choice motions (option_id → choice)

Hidden motions with no vote are never sent to the voter (server-side filter prevents title leakage).

### `PUT /api/general-meeting/{id}/draft`

Saves/deletes a draft vote choice for a single motion + lot. Requires session. Draft votes are automatically deleted when the meeting closes.

Ownership check: `_verify_lot_ownership(db, voter_email, lot_owner_id, building_id)` — 403 if the voter does not own or proxy for the specified lot.

### `POST /api/general-meeting/{id}/submit`

Request: `{ lot_owner_ids: [uuid], votes: [VoteInlineItem], multi_choice_votes: [MultiChoiceVoteItem] }`.

Logic for each `lot_owner_id`:
1. Verify ownership (direct `LotOwnerEmail` or `LotProxy`)
2. Check `financial_position_snapshot` from `GeneralMeetingLotWeight`; if `in_arrear`, record `not_eligible` for all General motions
3. Iterate over visible motions (`is_visible = True` AND no existing submitted vote for this lot)
4. Insert `Vote(status=submitted)` rows; skip motions already voted on (idempotent re-entry)
5. Upsert `BallotSubmission` (reuse existing row if lot already has one — phased voting)
6. 403 if `general_meeting_id` is `pending`
7. 403 if meeting is `closed`
8. 422 if a motion in the request has `voting_closed_at IS NOT NULL` ("Voting has closed for motion: {motion_number}")

### `GET /api/general-meeting/{id}/my-ballot`

Returns submitted votes for all lots belonging to the authenticated voter. Only returns motions that have actual submitted `Vote` rows (no auto-abstain display for unvoted motions). `BallotVoteItem` includes `motion_title`, `display_order`, `motion_number`, `choice`, `motion_type`, `selected_options` (multi-choice), `option_choices` (multi-choice per-option).

---

## Frontend Components

### `VotingPage.tsx` (`frontend/src/pages/vote/VotingPage.tsx`)

- Polls `GET /api/general-meeting/{id}/motions` every 10 seconds to pick up newly revealed motions and per-motion close events
- Holds `choices: Record<string, VoteChoice>` for general/special motions
- Holds `multiChoiceSelections: Record<string, OptionChoice[]>` for multi-choice motions
- Progress bar: `motions.filter(m => !m.already_voted).length` as denominator (only unvoted visible motions count)
- Already-voted motions (`already_voted = true`) render read-only — choice is displayed but cannot be changed
- Motions with `voting_closed_at IS NOT NULL` show "Voting closed" label; controls disabled
- Empty motions state: "No motions are available yet. Please check back shortly."
- All-already-voted state: "No new motions" message + "View Submission" button

Multi-lot sidebar: shown when `allLots.length > 1`. Proxy lots show "via Proxy" badge. "Select Proxy Lots" and "Select Owned Lots" shortcut buttons shown when `hasProxyLot`.

Single-lot proxy voter: compact inline strip above motions showing lot number + "via Proxy" badge.

### `MotionCard.tsx` (`frontend/src/components/vote/MotionCard.tsx`)

- For/Against/Abstain buttons (general/special motions)
- `MultiChoiceOptionList` (multi-choice motions)
- `readOnly` prop when `already_voted = true`
- Keyboard navigable; all interactive elements have visible focus states

### `ConfirmationPage.tsx` (`frontend/src/pages/vote/ConfirmationPage.tsx`)

Fetches `GET /api/general-meeting/{id}/my-ballot`. Renders submitted votes per lot. Support email displayed if configured (`useBranding()`). "Vote for remaining lots" button driven by `remaining_lot_owner_ids` in session state.

### `LotSelectionPage.tsx` / lot sidebar

Lots loaded from `sessionStorage["meeting_lots_info_<meetingId>"]` (written by `AuthPage` after successful auth). Each lot shows lot number, financial position badge (`in_arrear` → amber badge), and proxy badge.

---

## Key Behaviours

### Proxy voting

Auth resolution is a union of direct owners (`LotOwnerEmail`) and proxy nominations (`LotProxy`). When both overlap for the same lot, `is_proxy = False` (direct ownership takes precedence). `BallotSubmission.proxy_email` is set to the voter's email when submitting as proxy (audit-only field, never exposed in API responses). The "via Proxy" badge is rendered client-side based on `LotInfo.is_proxy`.

### Re-entry / phased voting

When new motions are revealed after a voter has already submitted, `unvoted_visible_count > 0` routes them back to the voting page on re-auth. `submit_ballot` reuses the existing `BallotSubmission` row and only inserts `Vote` rows for motions not yet voted on. Already-voted motions render read-only in `MotionCard`.

### In-arrear lot handling

In-arrear lots have a snapshot (`financial_position_snapshot = 'in_arrear'`) on `GeneralMeetingLotWeight`. During `submit_ballot`, General motions for in-arrear lots are recorded as `not_eligible`. Special motions are still eligible. Multi-choice motions also record `not_eligible` for in-arrear lots.

### Back-navigation and re-voting guards

- Back-button navigation to an already-submitted lot is handled by checking `LotInfo.already_submitted`; the page redirects to confirmation or shows the already-submitted state.
- `BallotSubmission` reuse (phased voting) means revisiting the voting page after partial submission is safe.
- Stale already-submitted state when new motions are revealed: `unvoted_visible_count` from `auth/verify` is the authoritative signal.

### Draft votes

`PUT /api/general-meeting/{id}/draft` persists `Vote(status=draft)` rows for auto-save. All draft votes are deleted when the meeting closes. Draft endpoint enforces `_verify_lot_ownership` (403 on cross-voter access).

---

## Accessibility

- All form controls have visible `<label>` elements or `aria-label`
- Error and status messages use `role="alert"` or `aria-live="polite"`
- All flows completable with keyboard alone (Tab, Enter, Space, Arrow keys)
- Focus states visible after keyboard interaction (CSS focus-visible)
- "via Proxy" and "In Arrear" badges have accessible text (not icon-only)
- Vote buttons have sufficient colour contrast (not relying solely on colour to indicate state)
- Loading states announced via `aria-live`

---

## Edge Cases

- Back button after ballot submitted: `LotInfo.already_submitted` prevents re-submission; confirmation page shown
- Multiple browser tabs: duplicate submit returns idempotent result (Vote unique constraints prevent duplicate rows)
- Meeting closed mid-vote: 403 on submit; voter sees error; confirmation page accessible via auth
- Per-motion close while voting: 422 on submit for closed motion; voter is notified with specific motion number
- Proxy nomination removed after authentication: session remains valid; submit re-checks ownership (403 if proxy no longer valid)

---

## Files

| File | Role |
|---|---|
| `backend/app/routers/voting.py` | `list_motions`, `save_draft`, `submit_ballot`, `get_my_ballot` endpoints |
| `backend/app/services/voting_service.py` | Business logic for draft, submit, ballot confirmation |
| `backend/app/schemas/voting.py` | `MotionOut`, `SubmitBallotRequest`, `BallotVoteItem`, `MultiChoiceVoteItem` |
| `frontend/src/pages/vote/VotingPage.tsx` | Main voting page with lot sidebar |
| `frontend/src/pages/vote/ConfirmationPage.tsx` | Post-submission confirmation |
| `frontend/src/pages/vote/AuthPage.tsx` | Post-auth routing using `unvoted_visible_count` |
| `frontend/src/components/vote/MotionCard.tsx` | Per-motion voting UI |
| `frontend/src/components/vote/MultiChoiceOptionList.tsx` | Multi-choice option checkboxes/buttons |
| `frontend/src/api/voter.ts` | All voter-facing API client functions |

---

## Schema Migration Required

No additional migrations beyond those described in other design docs. The voting flow uses existing tables (`votes`, `ballot_submissions`, `session_records`).
