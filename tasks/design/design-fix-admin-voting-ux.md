# Design: Admin Voting Page Re-vote UX (Fix 5)

**Status:** Implemented

PRD reference: `prd-admin-panel.md` — US-AVE-01/02/03

---

## Overview

When an admin opens the in-person vote entry panel for a lot that has **already voted** (either via the voter portal or via a previous admin entry), the panel currently:

1. Shows no indication that prior votes exist for those lots.
2. Starts with all vote buttons blank, giving no visual hint of what was previously recorded.
3. Has no warning before submission that existing votes cannot be overwritten — lots with existing submissions are silently skipped by the backend (`skipped_count` incremented), which can mislead the admin into believing votes were saved when they were not.

The voter-facing `VotingPage` has full re-vote UX: it loads and shows prior selections (read-only) for fully-voted motions, and it shows a `MixedSelectionWarningDialog` when some selected lots have prior votes while others do not.

This fix brings the admin panel to parity with the voter page for this scenario.

---

## Analysis of Existing Behaviour

### How the voter page handles prior votes

1. `GET /api/general-meeting/{id}/motions` returns each motion with:
   - `already_voted: bool` — whether the voter's lots have a submitted vote for this motion
   - `submitted_choice: VoteChoice | null` — the recorded choice (or `null`)
   - `submitted_option_choices: Record<string, string>` — per-option choices for multi-choice motions

2. `POST /api/auth/session` (restore session) returns `LotInfo[]`, each carrying `voted_motion_ids: string[]` — the motion IDs for which this lot has an existing submitted vote.

3. `VotingPage` uses these two data sources:
   - `isMotionReadOnly(motion)` — returns `true` when every selected lot has voted on the motion.
   - A seeding effect pre-fills `choices` and `multiChoiceSelections` for read-only motions only.
   - `MixedSelectionWarningDialog` fires when selected lots have differing `voted_motion_ids` sets.
   - `SubmitDialog` is shown before final submission with a list of unanswered motions.

### How the admin panel currently works

- Step 1: Lots are displayed from `GET /api/admin/buildings/{id}/lot-owners`. Lots whose `lot_number` appears in any motion's `voter_lists` (where `submitted_by_admin == false`) are filtered out as "app-submitted" and hidden from the selectable list. Lots that were **admin-submitted** (`submitted_by_admin == true`) are NOT excluded — they still appear in step 1.
- Step 2: A vote entry grid is rendered. `lotVotes` state starts blank — no prior selections are pre-filled regardless of whether the lot has been voted before.
- On submit: `POST /api/admin/general-meetings/{id}/enter-votes` — the backend skips any lot that already has a real (non-absent) `BallotSubmission` record, regardless of who submitted it (voter portal or admin). The `skipped_count` is returned in the response but the frontend currently does not surface this to the admin.

### The gap

The admin panel does not:
- Show existing vote selections in the grid for lots that have been admin-submitted
- Warn the admin that admin-submitted lots cannot have new votes entered (they will be silently skipped)
- Show `skipped_count` in a meaningful way after submission

### What data is already available

The `GeneralMeetingDetail` object (already fetched and passed as `meeting` prop to `AdminVoteEntryPanel`) contains `voter_lists` for each motion, including the `submitted_by_admin: bool` flag and `lot_number` per voter entry.

This means previous vote choices for admin-submitted lots are derivable from `meeting.motions[*].voter_lists` **without any new backend endpoint**. Specifically:

- A lot number appears in `voter_lists.yes/no/abstained/not_eligible` with `submitted_by_admin == true` → it was admin-submitted; its prior choice is known.
- For multi-choice motions, `voter_lists.options_for/options_against/options_abstained` carry per-option voter lists.

However, the `voter_lists` data is per-lot-number (not per-lot-owner-id), and the data carried is the same "category bucket" (yes/no/abstained/not_eligible) — not the motion-level submitted choice per lot in an easily-indexable form. The admin panel already has the `allLotOwners` list from `GET /api/admin/buildings/{id}/lot-owners` (which returns `LotOwner` objects with `id` and `lot_number`), so a lookup from `lot_number` to prior choice is possible.

---

## Technical Design

### No backend changes required

All data needed to show prior votes is already present in `GeneralMeetingDetail.motions[*].voter_lists`. No new endpoints or schema changes are needed. No migration is required.

### Frontend changes

All changes are confined to `AdminVoteEntryPanel.tsx`.

#### 1. Derive prior vote data from `meeting.motions`

Add a helper that, given the `meeting` prop and `allLotOwners`, builds:

```
priorVotesByLotId: Record<string, LotVotes>
```

Where `LotVotes` has the same shape used by `lotVotes` state: `{ choices: Record<string, VoteChoice>, multiChoiceChoices: Record<string, Record<string, OptionChoice>> }`.

**Binary motions:** Walk `motion.voter_lists.yes/no/abstained/not_eligible` for each visible motion. For each entry where `submitted_by_admin == true`, look up the `lot_owner_id` via `lot_number`. Record the prior choice (`yes/no/abstained/not_eligible`).

**Multi-choice motions:** Walk `motion.voter_lists.options_for`, `options_against`, `options_abstained` (keyed by `option_id`). For each entry where `submitted_by_admin == true`, record the per-option choice.

This computation is a pure function of `meeting` and `allLotOwners`, so it can be wrapped in `useMemo` with those two values as dependencies.

#### 2. Identify admin-submitted lots

The existing `appSubmittedLotNumbers` set already excludes lots with `submitted_by_admin == false`. Add an analogous `adminSubmittedLotNumbers` set:

```ts
const adminSubmittedLotNumbers = new Set<string>();
for (const motion of meeting.motions) {
  for (const cat of ["yes", "no", "abstained", "not_eligible"] as const) {
    for (const v of motion.voter_lists[cat]) {
      if (v.lot_number && v.submitted_by_admin) {
        adminSubmittedLotNumbers.add(v.lot_number);
      }
    }
  }
}
```

#### 3. Step 1 — Show admin-submitted lots with a warning indicator

Currently, admin-submitted lots appear in the step-1 selectable list with no distinction. After this fix, they remain selectable but display an amber "Previously entered by admin" badge (consistent with the `in_arrear` badge already shown in step 1). The admin can still select them, but will see a confirmation warning before submitting.

#### 4. Seed `lotVotes` with prior choices when entering step 2

When the admin advances to step 2, pre-fill `lotVotes` for each selected lot that has prior admin-submitted votes. This mirrors how `VotingPage` seeds `choices` from `submitted_choice`.

Implementation: in the `setStep(2)` handler (or in a `useEffect` that watches `step`), for each `lotId` in `selectedLotIds`, if `priorVotesByLotId[lotId]` exists, initialise `lotVotes[lotId]` with the prior value instead of the blank `initialLotVotes()`.

#### 5. Step 2 — Indicate read-only cells for admin-submitted lots

For any lot column where the lot was admin-submitted (i.e. `adminSubmittedLotNumbers.has(lo.lot_number)`), the vote buttons should still be interactive (the admin may want to see the prior choice), but a small label "Previous vote" appears above the buttons to signal the pre-filled state. The buttons are active as before — the admin can change the selection — but the backend will silently skip the lot if it still has a ballot.

The "read-only but informational" approach is preferred over disabling buttons entirely, because an admin who knows the ballot was wrongly entered may still want to review the displayed choices. The actual enforcement (skip) happens at the backend.

**Why not disable the buttons?** Disabling would hide what was previously entered. The admin panel's purpose is to surface information, and showing prior choices even for locked lots is useful. The warning dialog (below) makes the skip behaviour explicit.

#### 6. Warning dialog before submission when admin-submitted lots are selected

When the admin clicks "Submit votes" and one or more selected lots are in `adminSubmittedLotNumbers`, show a blocking confirmation dialog **before** the existing `ConfirmDialog`. The new dialog is called `AdminRevoteWarningDialog` (inline component within the file, same pattern as `ConfirmDialog`).

Dialog content:

- Title: "Some lots have already been entered"
- Body: "The following lot(s) already have admin-entered votes and cannot be overwritten. They will be skipped when you submit — their existing votes will remain unchanged."
- Bulleted list of `lot_number` values for admin-submitted lots in the selection
- Secondary message: "Lots without prior entries will be submitted normally."
- Buttons: "Go back" (cancel the submission) and "Continue anyway" (proceed to the existing `ConfirmDialog`)

This mirrors the `MixedSelectionWarningDialog` used on the voter page.

#### 7. Surface `skipped_count` after submission

On `onSuccess`, the existing flow calls `onSuccess()` which closes the panel and refreshes the meeting detail. Extend the `onSuccess` mutation handler to capture `skipped_count` from the result and, if `skipped_count > 0`, show a brief `role="alert"` banner inside the panel before it closes, or pass the count to the caller via a callback. 

The simplest approach given the current architecture: store `submitResult` state (`{ submitted_count, skipped_count } | null`) and render it in a `role="alert"` banner in step 2 between the table and the submit button. When `skipped_count > 0` the panel stays open (instead of immediately calling `onSuccess()`) so the admin can read the message; a "Done" button then closes it. When `skipped_count == 0` the existing behaviour (immediate `onSuccess()` close) is preserved.

---

## Data Flow (end-to-end happy path — re-vote scenario)

1. Admin opens `AdminVoteEntryPanel`. `meeting` prop includes `voter_lists` with admin-submitted entries.
2. Component derives `adminSubmittedLotNumbers` and `priorVotesByLotId` from `meeting.motions` (memoised).
3. Step 1 renders. Admin-submitted lots appear with an amber "Previously entered by admin" badge alongside the existing in-arrear badge.
4. Admin selects one or more lots (which may include admin-submitted ones) and clicks "Proceed".
5. `lotVotes` is seeded for each selected lot that has prior votes.
6. Step 2 renders. Columns for admin-submitted lots show pre-filled vote buttons and a "Previous vote" label above each column.
7. Admin clicks "Submit votes".
8. `handleSubmitClick` checks whether any selected lot is in `adminSubmittedLotNumbers`. If yes: `setShowRevoteWarning(true)` — `AdminRevoteWarningDialog` is shown.
9. Admin clicks "Continue anyway" — `setShowRevoteWarning(false)`, `setShowConfirm(true)` — existing `ConfirmDialog` appears.
10. Admin clicks "Confirm" — `POST /api/admin/general-meetings/{id}/enter-votes` fires.
11. Backend skips admin-submitted lots (already has a `BallotSubmission`), records new lots normally.
12. Response includes `{ submitted_count, skipped_count }`.
13. If `skipped_count > 0`: panel stays open, renders amber alert "N lot(s) were skipped (already submitted). M lot(s) were submitted." with a "Done" button.
14. If `skipped_count == 0`: existing `onSuccess()` is called immediately, panel closes.

---

## UX Specification

### Step 1 — Admin-submitted lot badge

```
[✓] Lot 1A   [In arrear]  [Previously entered by admin]
```

Badge: `--amber-bg` background, `--amber` text, `--r-sm` border-radius, `0.7rem` font size. Same inline style pattern as the "In arrear" badge already in the file (lines 448–459 of `AdminVoteEntryPanel.tsx`).

### Step 2 — Prior vote pre-fill indicator

Above the vote buttons in each column for admin-submitted lots:

```
Lot 1A
[All answered]  [In arrear]  [Previously entered by admin]
```

For the vote cells in those columns, the existing vote buttons function normally (not disabled), but a `0.65rem` grey italic label "Prev. entry" appears above the button group for each motion cell — same position as the "Not eligible" placeholder for in-arrear lots.

### `AdminRevoteWarningDialog`

```
Title: Some lots have already been entered
Body:  The following lots already have votes recorded by admin. They will be
       skipped on submission — their existing votes are preserved:
         • Lot 1A
         • Lot 3C
       Lots without prior entries (Lot 2B) will be submitted normally.
Buttons: [Go back]  [Continue anyway]
```

Same modal pattern as `ConfirmDialog` in this file: fixed-position backdrop, white panel with `var(--r-lg)`, `var(--shadow-lg)`, focus trap, Escape to cancel, initial focus on "Go back" (safer default).

### Post-submission skipped count banner

```
⚠  2 lot(s) were skipped (already had entries). 1 lot was submitted successfully.
[Done]
```

Amber `role="alert"` banner above the submit button area. "Done" calls `onSuccess()`.

---

## Files to Change

| File | Change |
|------|--------|
| `frontend/src/pages/admin/AdminVoteEntryPanel.tsx` | (1) Add `adminSubmittedLotNumbers` derived set. (2) Add `priorVotesByLotId` memo from `meeting.motions` + `allLotOwners`. (3) Seed `lotVotes` with prior data on step transition. (4) Badge for admin-submitted lots in step 1 lot list. (5) "Previously entered" column badge in step 2. (6) "Prev. entry" per-cell label in step 2 vote cells. (7) `showRevoteWarning` state + `AdminRevoteWarningDialog` inline component. (8) `handleSubmitClick` guard for revote warning. (9) `submitResult` state + post-submission skipped-count banner and "Done" button. |
| `frontend/src/pages/admin/__tests__/AdminVoteEntryPanel.test.tsx` | Add test cases for all new behaviours (see Test Cases). |
| `frontend/tests/msw/handlers.ts` | Add `ADMIN_MEETING_DETAIL_WITH_ADMIN_VOTES` fixture — an open meeting where some lots have `submitted_by_admin: true` voter_list entries. |

No backend files change.

---

## Security Considerations

No security implications. This is a purely frontend display change. The backend already enforces that admin-submitted lots cannot be re-submitted (they are skipped at the service layer with an `IntegrityError` guard). The admin page cannot bypass this enforcement.

---

## Schema Migration Required

No.

---

## Test Cases

### Unit / integration (Vitest + RTL)

| ID | Scenario | Expected |
|----|----------|----------|
| AVE-RV-01 | Step 1 renders amber badge for admin-submitted lot | "Previously entered by admin" badge visible for that lot |
| AVE-RV-02 | Step 1 does not show amber badge for voter-submitted lot | Badge absent for lots where `submitted_by_admin == false` |
| AVE-RV-03 | Advancing to step 2 with admin-submitted lot pre-fills vote buttons | The prior choice button shows `aria-pressed="true"` |
| AVE-RV-04 | Step 2 shows "Previously entered by admin" column badge for admin-submitted lot | Badge present in column header |
| AVE-RV-05 | Step 2 shows "Prev. entry" label in vote cell for admin-submitted lot | Label visible above vote buttons |
| AVE-RV-06 | Clicking "Submit votes" with an admin-submitted lot selected shows `AdminRevoteWarningDialog` | Dialog with title "Some lots have already been entered" appears |
| AVE-RV-07 | `AdminRevoteWarningDialog` lists the admin-submitted lot numbers | Lot numbers rendered in the dialog list |
| AVE-RV-08 | Clicking "Go back" in `AdminRevoteWarningDialog` dismisses it without proceeding | Dialog disappears, `ConfirmDialog` not shown |
| AVE-RV-09 | Clicking "Continue anyway" in `AdminRevoteWarningDialog` advances to `ConfirmDialog` | `ConfirmDialog` appears |
| AVE-RV-10 | No revote warning when no admin-submitted lots are selected | `AdminRevoteWarningDialog` never shown; goes directly to `ConfirmDialog` |
| AVE-RV-11 | `skipped_count > 0` in submit response: panel stays open, shows skipped banner | Amber alert with skipped count visible; "Done" button present |
| AVE-RV-12 | `skipped_count == 0` in submit response: `onSuccess` called immediately | `onSuccess` mock called; no skipped banner |
| AVE-RV-13 | Escape key closes `AdminRevoteWarningDialog` | Dialog dismissed, `onClose` not called |
| AVE-RV-14 | Multi-choice prior votes pre-fill option buttons in step 2 | Previously-voted option buttons show `aria-pressed="true"` |
| AVE-RV-15 | Focus trap in `AdminRevoteWarningDialog` | Tab cycles within the dialog |

### Multi-step E2E scenario

**Scenario: Admin re-enters votes for a lot that was previously admin-entered**

1. Seed: open meeting with 2 lots; lot 1A has a prior admin-submitted ballot; lot 2B has no prior ballot.
2. Open `AdminVoteEntryPanel`.
3. Step 1: assert lot 1A shows "Previously entered by admin" badge; lot 2B does not.
4. Select both lots. Click "Proceed".
5. Step 2: assert lot 1A column shows prior vote pre-filled and "Previously entered by admin" badge.
6. Assert lot 2B column starts blank.
7. Click "Submit votes".
8. Assert `AdminRevoteWarningDialog` appears; lot 1A is listed.
9. Click "Continue anyway"; assert `ConfirmDialog` appears.
10. Click "Confirm".
11. Assert backend receives `POST /enter-votes` with both lot IDs.
12. Assert skipped-count banner appears showing "1 lot skipped".
13. Click "Done"; assert `onSuccess` called.

---

## E2E Test Scenarios

### Existing E2E specs affected

The admin persona journey covers: login → building/meeting management → vote entry → close meeting. The E2E spec for vote entry (`e2e_tests/` — admin vote entry flow) must be updated to:
- Cover the case where the admin opens vote entry for a lot that was previously entered (verify warning dialog appears and skipped-count banner shows after submission).
- Verify that "Previously entered by admin" badge appears for admin-submitted lots in step 1.

### New scenarios

| Scenario | Steps |
|----------|-------|
| Happy path — first admin entry | Select unvoted lots, fill grid, submit → `onSuccess` immediately, no warning |
| Admin-submitted lot present — go back | Select lot with prior admin entry → submit → warning dialog → "Go back" → dialog dismissed, stays on grid |
| Admin-submitted lot present — continue | Select lot with prior admin entry + unvoted lot → submit → warning → "Continue" → confirm → submit → skipped-count banner (1 skipped) → "Done" closes panel |
| All selected lots previously admin-entered | Warning dialog lists all lots; submit → all skipped; banner shows "2 skipped, 0 submitted" |
| Multi-choice prior votes pre-filled | Open panel for meeting with admin-submitted multi-choice votes → step 2 shows pre-filled options |

---

## Vertical Slice Decomposition

This fix is self-contained within `AdminVoteEntryPanel.tsx` and its test file. It touches no backend, no other frontend pages, and no shared components. It can be implemented as a single slice on the `fix-admin-voting-ux` branch.
