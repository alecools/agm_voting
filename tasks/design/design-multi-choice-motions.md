# Design: Multi-Choice Motions

## Overview

Multi-choice motions present voters with a set of custom text options (e.g. candidates, sites, proposals). Each option supports independent For/Against/Abstain voting. The admin sets an `option_limit` (maximum "For" selections per voter). At meeting close, a pass/fail/tie outcome is computed for each option based on For vs Against weighted entitlements and stored as a snapshot. The admin results view shows a per-option For/Against/Abstained breakdown with drill-down voter lists.

---

## Data Model

### `motion_options` table

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `motion_id` | UUID FK → `motions.id` CASCADE | |
| `text` | VARCHAR | NOT NULL; max 200 chars |
| `display_order` | INTEGER | NOT NULL; unique per motion via `uq_motion_options_motion_display_order` |
| `outcome` | VARCHAR | nullable; `'pass'`, `'fail'`, or `'tie'`; stored at meeting close |
| `for_voter_count` | INTEGER | NOT NULL DEFAULT 0; snapshot stored at close |
| `for_entitlement_sum` | INTEGER | NOT NULL DEFAULT 0 |
| `against_voter_count` | INTEGER | NOT NULL DEFAULT 0 |
| `against_entitlement_sum` | INTEGER | NOT NULL DEFAULT 0 |
| `abstained_voter_count` | INTEGER | NOT NULL DEFAULT 0 |
| `abstained_entitlement_sum` | INTEGER | NOT NULL DEFAULT 0 |

### Changes to `votes` table

- Added `motion_option_id` (UUID nullable FK → `motion_options.id` CASCADE)
- Dropped old unique constraint `uq_votes_gm_motion_lot_owner`
- Added two partial unique indexes:
  - `uq_votes_non_multi_choice` ON `(gm_id, motion_id, lot_owner_id)` WHERE `motion_option_id IS NULL`
  - `uq_votes_multi_choice` ON `(gm_id, motion_id, lot_owner_id, motion_option_id)` WHERE `motion_option_id IS NOT NULL`

### Changes to `VoteChoice` enum

Added values: `selected` (stored for "For" votes on multi-choice options), `against` (stored for Against votes on options).

---

## API Endpoints

Multi-choice extends existing endpoints without new paths.

### `POST /api/admin/general-meetings` and `POST /api/admin/general-meetings/{id}/motions`

`MotionCreate` / `MotionAddRequest` gains `option_limit: int | None` and `options: list[MotionOptionCreate]`. Validation: when `motion_type == multi_choice`, `option_limit >= 1`, `len(options) >= 2`, `option_limit <= len(options)`.

### `PATCH /api/admin/motions/{id}`

`MotionUpdateRequest` gains `option_limit` and `options`. When `options` is provided, existing options are deleted and replaced atomically.

### `GET /api/admin/general-meetings/{id}`

`MotionDetail.tally` gains `options: list[OptionTallyEntry]` (populated only for multi-choice motions). `MotionVoterLists` gains `options_for`, `options_against`, `options_abstained` dicts (keyed by `option_id` string).

`OptionTallyEntry` fields: `option_id`, `option_text`, `display_order`, `outcome`, `for_voter_count`, `for_entitlement_sum`, `against_voter_count`, `against_entitlement_sum`, `abstained_voter_count`, `abstained_entitlement_sum`. Legacy aliases `voter_count` (= `for_voter_count`) and `entitlement_sum` (= `for_entitlement_sum`) are retained for one release.

### `GET /api/general-meeting/{id}/motions`

Voter-facing `MotionOut` gains `option_limit: int | None` and `options: list[MotionOptionOut]` for multi-choice motions.

### `POST /api/general-meeting/{id}/submit`

`SubmitBallotRequest` gains `multi_choice_votes: list[MultiChoiceVoteItem]` (parallel to `votes` for general/special). Each `MultiChoiceVoteItem` contains `{ motion_id, option_choices: [{ option_id, choice: "for"|"against"|"abstained" }] }`.

Rules:
- Option IDs validated against actual `MotionOption` rows for the motion (400 on unknown IDs)
- "For" count enforced against `option_limit` (422 if exceeded; Against and Abstained do not consume the limit)
- In-arrear lots: multi-choice vote recorded as `not_eligible`
- Empty `option_choices` → one `Vote(choice=abstained, motion_option_id=None)` (motion-level abstain)

### `GET /api/general-meeting/{id}/my-ballot`

`BallotVoteItem` gains `motion_type`, `selected_options: list[MotionOptionOut]`, and `option_choices: list[{option_id, option_text, choice}]`. Multi-choice motions group all per-option vote rows into one `BallotVoteItem` with `selected_options` populated.

---

## Pass/Fail Outcome Algorithm

`compute_multi_choice_outcomes(general_meeting_id, db)` is called by `close_general_meeting`:

1. For each `multi_choice` motion, for each option:
   - Compute `against_entitlement_sum` from `Vote(choice=against, motion_option_id=option.id)` rows
   - An option **fails** if `against_entitlement_sum / total_building_entitlement > 0.50`
2. Rank non-failed options by `for_entitlement_sum` descending
3. Top `option_limit` non-failed options **pass** — unless positions `option_limit` and `option_limit + 1` have equal `for_entitlement_sum`, in which case both (and all others at the boundary) are marked **tie**
4. Store all six snapshot counts (`for_voter_count`, `for_entitlement_sum`, `against_voter_count`, `against_entitlement_sum`, `abstained_voter_count`, `abstained_entitlement_sum`) and `outcome` on each `MotionOption` row

---

## Frontend Components

### `MultiChoiceOptionList.tsx` (`frontend/src/components/vote/MultiChoiceOptionList.tsx`)

Rendered within `MotionCard` when `motion.motion_type === "multi_choice"`. One row per option with three compact buttons: "For" / "Against" / "Abstain". Counter label: `"Select up to {option_limit} option(s) — {x} voted For"`. "For" button disabled when `option_limit` reached AND this option is not already "For".

In `readOnly` mode (already-voted): all buttons disabled; selected options shown as static labels.

### `MotionCard.tsx`

Conditionally renders `MultiChoiceOptionList` when `motion.motion_type === "multi_choice"`, otherwise renders the existing For/Against/Abstain buttons.

### `VotingPage.tsx`

Holds `multiChoiceSelections: Record<string, { option_id: string; choice: string }[]>` state. Builds `multi_choice_votes` array in the submit request. Progress bar counts a multi-choice motion as answered once the voter has interacted with it (key exists in state map).

### `AGMReportView.tsx`

For multi-choice motions, renders a collapsible section per option:
```
[Option text]    [OutcomeBadge]    [▶ expand]
  For            voter_count  ent_sum
  Against        voter_count  ent_sum
  Abstained      voter_count  ent_sum
```

`OutcomeBadge`: green "Pass", red "Fail", amber "Tie — admin review required".

CSV export adds rows per option per category: `"Option: {text} — For"`, `"Option: {text} — Against"`, `"Option: {text} — Abstained"`.

### Admin motion creation/edit modals

When `motion_type === "multi_choice"`: show option_limit number input and a dynamic list of option text inputs (add/remove/reorder with up/down buttons). Validation: min 2 options, `option_limit <= option count`.

### `MotionManagementTable.tsx`

Type badge shows "Multi-Choice (N options)" for multi-choice motions.

### Confirmation page

`BallotVoteItem` with `motion_type === "multi_choice"` renders selected option texts as a list. Empty selection → "Abstained". `not_eligible` → "Not eligible".

---

## Key Behaviours

- **"Selected" vote choice is For**: `choice = "selected"` is stored for Forward votes to preserve backward compatibility with existing rows from the checkbox model.
- **Option limit counts only "For" selections**: Against and Abstained votes do not consume the limit.
- **Motion-level abstain vs option-level abstain**: leaving all options untouched → one `Vote(abstained, option_id=None)`. Explicitly marking an option "Abstained" → `Vote(abstained, option_id=option.id)`.
- **Open-meeting tally**: computed live from vote rows. Closed-meeting tally: read from snapshot columns on `MotionOption`.
- **Outcome is immutable after close**: `compute_multi_choice_outcomes` runs once at close time; the result is stored in `motion_options.outcome`.

---

## Security Considerations

- Option IDs validated against actual DB rows for the motion before insert (prevents cross-motion option injection)
- Option limit enforced server-side regardless of frontend state
- In-arrear lot rule applies to multi-choice motions (same as general motions)
- Admin endpoints for option management are behind `require_admin`
- Option text sanitised via `_sanitise_option_text` helper (same as `_sanitise_description`)

---

## Files

| File | Role |
|---|---|
| `backend/app/models/motion_option.py` | `MotionOption` model |
| `backend/app/models/motion.py` | `MotionType.multi_choice`, `option_limit` |
| `backend/app/models/vote.py` | `VoteChoice.selected`, `VoteChoice.against`, `motion_option_id` column |
| `backend/app/schemas/admin.py` | `MotionOptionCreate/Out`, `OptionTallyEntry`, updated `MotionDetail`/`MotionTally`/`MotionVoterLists` |
| `backend/app/schemas/voting.py` | `MultiChoiceVoteItem`, `MultiChoiceOptionChoice`, updated `MotionOut`, `BallotVoteItem` |
| `backend/app/services/admin_service.py` | `compute_multi_choice_outcomes`; tally computation in `get_general_meeting_detail` |
| `backend/app/services/voting_service.py` | `submit_ballot` multi-choice path; `get_my_ballot` multi-choice grouping |
| `backend/app/routers/voting.py` | Parse `multi_choice_votes` from request; pass to service |
| `backend/app/templates/report_email.html` | Per-option For/Against/Abstained rows + outcome badge |
| `frontend/src/types.ts` | `MotionType` union: add `"multi_choice"` |
| `frontend/src/api/voter.ts` | `MotionOptionOut`, `MultiChoiceVoteItem`, extended `MotionOut`/`BallotVoteItem` |
| `frontend/src/api/admin.ts` | `MotionOptionCreate/Out`, `OptionTallyEntry`, `options_for/against/abstained` voter list types |
| `frontend/src/components/vote/MultiChoiceOptionList.tsx` | Option row with For/Against/Abstain buttons |
| `frontend/src/components/admin/AGMReportView.tsx` | Collapsible per-option tally with OutcomeBadge |
| `frontend/src/pages/vote/VotingPage.tsx` | Multi-choice state; build submit payload |

---

## Schema Migration Required

Yes — migrations added:
- `motion_options` table (with 6 tally snapshot columns and `outcome` column)
- `motions.option_limit` (INTEGER nullable)
- `motiontype` enum: `multi_choice`
- `votechoice` enum: `selected`, `against`
- `votes.motion_option_id` (UUID nullable FK)
- Drop `uq_votes_gm_motion_lot_owner`; add `uq_votes_non_multi_choice` and `uq_votes_multi_choice` partial indexes
