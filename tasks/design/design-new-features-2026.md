# Design: New Features 2026

## Overview

Seven features are added to the AGM Voting App: admin in-person vote entry, lot owner and proxy names, per-option For/Against/Abstain on multi-choice motions (voter-facing only), multi-choice pass/fail result calculation, a QR code for the voter share link, cross-owner ballot visibility on the confirmation page, and per-motion voting windows. Each feature is described as an independently deployable vertical slice below.

---

## Root Cause / Background

These features were requested to support in-person AGMs where paper ballots need to be digitised, to improve admin identification of lot owners, to align multi-choice motion UX with general/special resolution UX, to automate result determination, and to give meeting hosts finer-grained control over voting windows.

---

## Technical Design

### Slice 1 — Admin In-Person Vote Entry (US-AVE-01, US-AVE-02, US-AVE-03)

#### Database changes

**`ballot_submissions` table** — add one column:

```sql
ALTER TABLE ballot_submissions
  ADD COLUMN submitted_by_admin BOOLEAN NOT NULL DEFAULT FALSE;
```

No other schema changes. The existing `BallotSubmission` model, `Vote` model, and submission service path are reused. Admin vote entry creates `BallotSubmission` + `Vote` rows identically to the voter flow; the new flag distinguishes origin.

#### Backend changes

**New endpoint:** `POST /api/admin/general-meetings/{id}/enter-votes`

- Auth: `require_admin`
- Request body:
  ```json
  {
    "entries": [
      {
        "lot_owner_id": "<uuid>",
        "votes": [{"motion_id": "<uuid>", "choice": "yes|no|abstained"}],
        "multi_choice_votes": [{"motion_id": "<uuid>", "option_ids": ["<uuid>"]}]
      }
    ]
  }
  ```
- Behaviour:
  1. Verify meeting is open (effective status = `open`); return 409 if not.
  2. For each `lot_owner_id` in `entries`: reject with 409 if a `BallotSubmission` already exists for that lot in this meeting (app votes take precedence).
  3. Call the existing `submit_ballot` service for each lot, passing `inline_votes` and `multi_choice_votes` exactly as the voter flow does. All business rules (in-arrear ineligibility, option_limit, motion visibility) are enforced by the existing service layer — no new rule code needed.
  4. Set `submitted_by_admin = True` on each created `BallotSubmission`.
- Returns: `{"submitted_count": N, "skipped_count": M}` — skipped lots are those that already had a submission.
- Returns 404 if meeting not found.

**Modified `BallotSubmission` model** (`backend/app/models/ballot_submission.py`):
- Add `submitted_by_admin: Mapped[bool]` with `default=False, server_default="false"`.

**Modified `admin_service`** (`backend/app/services/admin_service.py`):
- Add `enter_votes_for_meeting(general_meeting_id, entries, db)` service function.
- Extend `get_general_meeting_detail` tally output to include `submitted_by_admin` flag on each `BallotSubmission` row in the voter list.

**Modified Pydantic schemas** (`backend/app/schemas/admin.py`):
- Add `AdminVoteEntry`, `AdminVoteEntryRequest`, `AdminVoteEntryResult` schemas.
- Extend `BallotSubmissionOut` with `submitted_by_admin: bool`.

**Modified CSV export** (`backend/app/services/email_service.py` or equivalent):
- Add `Submitted By` column: `"Admin"` when `submitted_by_admin`, else `"Voter"`.

#### Frontend changes

**New component:** `AdminVoteEntryPanel` (`frontend/src/pages/admin/AdminVoteEntryPanel.tsx`)
- Step 1: lot-selection checklist (US-AVE-01).
  - Fetches lots for the building; filters out lots already showing `submitted_by_admin = false AND has_submission = true` (i.e. app-submitted).
  - Renders each lot as a checkbox row: lot number + name (if available).
  - "Proceed to vote entry" button enabled when ≥1 lot checked.
- Step 2: vote entry grid (US-AVE-02).
  - Rows: visible motions (from the existing meeting detail motions list).
  - Columns: one per selected lot.
  - Cell component: `AdminVoteCellBinary` (For/Against/Abstain compact selector) or `AdminVoteCellMultiChoice` (compact option selector with `option_limit` enforcement).
  - In-arrear lots: cells for `general`/`multi_choice` motions are disabled with "Not eligible" label; `special` cells are active.
  - "Submit votes" button at bottom opens a confirmation dialog, then calls `POST /api/admin/general-meetings/{id}/enter-votes`.

**Modified `AdminMeetingDetailPage`** (`frontend/src/pages/admin/AdminMeetingDetailPage.tsx`):
- Show "Enter In-Person Votes" button in page header when `meeting.effective_status === "open"`.
- Clicking it mounts `AdminVoteEntryPanel` as an overlay/modal.

**Modified `AdminVoteEntryPanel` / results section:**
- Add "Admin entered" badge on `BallotSubmission` rows where `submitted_by_admin = true`.

**New API client function** (`frontend/src/api/admin.ts`):
- `enterInPersonVotes(meetingId, entries)` calling `POST /api/admin/general-meetings/{id}/enter-votes`.

---

### Slice 2 — Lot Owner Names (US-LON-01, US-LON-02)

#### Database changes

**`lot_owners` table** — add two nullable columns:

```sql
ALTER TABLE lot_owners
  ADD COLUMN given_name VARCHAR,
  ADD COLUMN surname    VARCHAR;
```

**`lot_proxies` table** — add two nullable columns:

```sql
ALTER TABLE lot_proxies
  ADD COLUMN given_name VARCHAR,
  ADD COLUMN surname    VARCHAR;
```

Both columns are nullable; no defaults required. Existing rows have `NULL` for both after migration.

#### Backend changes

**Modified `LotOwner` model** (`backend/app/models/lot_owner.py`):
- Add `given_name: Mapped[str | None]` and `surname: Mapped[str | None]`.

**Modified `LotProxy` model** (`backend/app/models/lot_proxy.py`):
- Add `given_name: Mapped[str | None]` and `surname: Mapped[str | None]`.

**Modified Pydantic schemas** (`backend/app/schemas/admin.py`):
- `LotOwnerCreate`: add optional `given_name: str | None = None`, `surname: str | None = None`.
- `LotOwnerUpdate`: add optional `given_name: str | None = None`, `surname: str | None = None`.
- `LotOwnerOut`: add `given_name: str | None`, `surname: str | None`.
- `SetProxyRequest`: add optional `given_name: str | None = None`, `surname: str | None = None`.
- Proxy sub-object within `LotOwnerOut`: add `given_name: str | None`, `surname: str | None`.

**Modified `admin_service`** (`backend/app/services/admin_service.py`):
- `add_lot_owner`: persist `given_name`/`surname` from `LotOwnerCreate`.
- `update_lot_owner`: persist `given_name`/`surname` from `LotOwnerUpdate`.
- `set_lot_owner_proxy`: persist `given_name`/`surname` on `LotProxy`.
- `import_lot_owners_from_csv` / `import_lot_owners_from_excel`: detect optional `given_name`/`surname` columns (case-insensitive); silently skip if absent.
- `import_proxies_from_csv` / `import_proxies_from_excel`: detect optional `proxy_given_name`/`proxy_surname` columns; silently skip if absent.

#### Frontend changes

**Modified `AddLotOwnerForm`** (within `BuildingDetailPage.tsx` or its own component):
- Add optional "Given name" and "Surname" `.field` inputs below existing fields.

**Modified `LotOwnerEditModal`**:
- Add "Given name" and "Surname" fields pre-filled from existing values.

**Modified lot owner table** on building detail page:
- Add a "Name" column rendering `${given_name ?? ""} ${surname ?? ""}`.trim(), showing blank for owners with no name.

No voter-facing pages are modified.

---

### Slice 3 — Multi-Choice Per-Option For/Against/Abstain (US-MC-SPLIT-01)

#### Database changes

**`VoteChoice` enum** — add new value `against`. The existing `selected` value is retained as the stored representation of "For" to preserve backward compatibility with existing rows. New `against` rows are stored with `choice = "against"` and `motion_option_id` set.

Migration:
```sql
ALTER TYPE votechoice ADD VALUE 'against';
```

No table structure changes; the new enum value is purely additive.

#### Backend changes

**Modified `VoteChoice` enum** (`backend/app/models/vote.py`):
- Add `against = "against"`.

**Modified submit service** (`backend/app/services/voting_service.py`):
- The existing `multi_choice_votes` request field changes shape. The frontend now sends per-option choices instead of a flat list of selected option IDs.
- New `MultiChoiceOptionChoice` schema: `{option_id: uuid, choice: "for" | "against" | "abstained"}`.
- New `MultiChoiceVoteItem` schema: `{motion_id: uuid, option_choices: list[MultiChoiceOptionChoice]}`.
- `submit_ballot` processes `option_choices`:
  - `choice == "for"` → store `Vote(choice=VoteChoice.selected, motion_option_id=option_id)` (consistent with existing "selected" rows).
  - `choice == "against"` → store `Vote(choice=VoteChoice.against, motion_option_id=option_id)`.
  - `choice == "abstained"` → store `Vote(choice=VoteChoice.abstained, motion_option_id=option_id)`.
  - Motion-level abstain (no options interacted with) → store one `Vote(choice=VoteChoice.abstained, motion_option_id=None)` as before.
- Enforce `option_limit` based on count of `choice == "for"` options only; `against`/`abstained` do not count.

**Modified voting schemas** (`backend/app/schemas/voting.py`):
- Replace `MultiChoiceVoteItem` with new shape: `option_choices` list instead of `option_ids`.
- Extend `BallotVoteItem` with `option_choices: list[{option_id, option_text, choice}]` for the confirmation endpoint.

**Modified `get_my_ballot`** (`backend/app/services/voting_service.py`):
- Return `option_choices` per multi-choice motion, including `against` choices.

**Modified `list_motions`** (`backend/app/routers/voting.py`):
- `submitted_option_ids_by_motion` is replaced with `submitted_option_choices_by_motion: dict[uuid, dict[uuid, VoteChoice]]` so the frontend can pre-populate prior per-option choices on re-entry.
- Update `MotionOut.submitted_option_ids` → rename to `submitted_option_choices: dict[str, str]` (option_id → choice string).

#### Frontend changes

**Modified `MotionCard`** (or new `MultiChoiceOptionRow` sub-component):
- Replace checkbox list with one row per option, each row having three compact buttons: "For" / "Against" / "Abstain".
- "For" button disabled when `option_limit` reached AND this option is not already set to "For".
- Counter label: "Select up to N option(s) — X voted For".

**Modified ballot submission** (`VotingPage.tsx`):
- Build `multi_choice_votes` as `[{motion_id, option_choices: [{option_id, choice}]}]`.

**Modified `MyBallotPage` / confirmation screen**:
- Render per-option choices using the updated `BallotVoteItem.option_choices`.

---

### Slice 4 — Multi-Choice Pass/Fail Outcome (US-MC-RESULT-01)

#### Database changes

Add `outcome` column to `motion_options`:

```sql
ALTER TABLE motion_options
  ADD COLUMN outcome VARCHAR CHECK (outcome IN ('pass', 'fail', 'tie')) DEFAULT NULL;
```

Outcome is computed once when the meeting is closed and stored. This avoids re-computation on every admin detail page load and ensures the result is stable after close.

#### Backend changes

**Modified `MotionOption` model** (`backend/app/models/motion_option.py`):
- Add `outcome: Mapped[str | None]` with nullable, no default.

**New service function** `compute_multi_choice_outcomes(general_meeting_id, db)` in `admin_service.py`:
- For each `multi_choice` motion in the meeting:
  1. Compute `total_building_entitlement` = sum of all `AGMLotWeight.unit_entitlement` for the meeting.
  2. For each option:
     - `for_entitlement_sum` = sum of UOE for lots with `Vote.choice = "selected"` (For) for this option.
     - `against_entitlement_sum` = sum of UOE for lots with `Vote.choice = "against"` for this option.
  3. Mark option as `fail` if `against_entitlement_sum / total_building_entitlement > 0.50`.
  4. Among remaining (non-failed) options, rank by `for_entitlement_sum` descending.
  5. Top `option_limit` ranked options: check for ties at the boundary.
     - If position `option_limit` and `option_limit + 1` have the same `for_entitlement_sum`, mark both and all others with the same score at the boundary as `tie`.
     - Positions 1 to `option_limit` without a tie boundary: mark `pass`.
     - Positions after `option_limit` without tie: mark `fail`.
  6. Persist `outcome` on each `MotionOption` row.

**Modified `close_general_meeting`** (`admin_service.py`):
- After setting `status = closed` and creating absent records, call `compute_multi_choice_outcomes`.

**Modified `get_general_meeting_detail`** (`admin_service.py`):
- Include `outcome` in `tally.options[]` in the response.

**Modified Pydantic schemas** (`backend/app/schemas/admin.py`):
- Add `outcome: str | None` to the option tally item schema.

**Modified email template** (`backend/app/services/email_service.py`):
- Add outcome label (Pass / Fail / Tie) beside each option row in the email.

#### Frontend changes

**Modified admin results section** in `AdminMeetingDetailPage.tsx`:
- Add an `OutcomeBadge` component: green "Pass", red "Fail", amber "Tie — admin review required".
- Render `OutcomeBadge` beside each option row when `outcome` is non-null.

---

### Slice 5 — QR Code for Voter Share Link (US-QR-01)

#### Database changes

None.

#### Backend changes

None. The voter URL is constructed entirely client-side from the known `agm_id`.

#### Frontend changes

**New dependency:** Add `qrcode.react` to `frontend/package.json`. This library is small (~15 KB gzipped) and voter-bundle safe (only used in the admin flow, so lazy-loading via dynamic import is used to keep it out of the voter bundle).

**New component:** `AgmQrCode` (`frontend/src/components/AgmQrCode.tsx`):
- Props: `agmId: string`, `voterBaseUrl: string`, `logoUrl: string | null`.
- Renders a `<QRCodeCanvas>` (from `qrcode.react`) with the `imageSettings` prop pointing to `logoUrl` when non-empty.
- `voterBaseUrl` is derived from `window.location.origin` + `/vote/${agmId}`.

**New component:** `AgmQrCodeModal` (`frontend/src/components/AgmQrCodeModal.tsx`):
- Renders a full-size `AgmQrCode` at 400×400 px.
- "Download PNG" button: gets a ref to the `<canvas>` element, calls `canvas.toDataURL("image/png")`, creates a temporary `<a>` tag with `download="agm-qr-{agmId}.png"` and clicks it programmatically.
- "Print" button: calls `window.print()` with a `@media print` style that hides everything except the QR canvas.
- Dismissible via "×" close button or backdrop click.

**Modified `AdminMeetingDetailPage.tsx`:**
- Import `AgmQrCode` lazily (`const AgmQrCode = lazy(() => import(...))`).
- Show a small inline `<AgmQrCode>` (size 120) in the "Share" section of the page header.
- Clicking the small QR code opens `AgmQrCodeModal`.

---

### Slice 6 — All Lot Owners See Submitted Ballot (US-MOV-01)

#### Database changes

None. `BallotSubmission` is already keyed on `lot_owner_id`. The fix is purely a backend query change.

#### Backend changes

**Modified `get_my_ballot`** (`backend/app/services/voting_service.py`):

Currently the function queries `BallotSubmission` filtered by `voter_email = session.voter_email`. This means a co-owner or proxy who did not submit cannot see the ballot.

Change the query to:
1. Resolve all `lot_owner_id` values associated with `session.voter_email` in this building (same lookup as in `list_motions`: direct `LotOwnerEmail` + `LotProxy`).
2. Query `BallotSubmission` by `lot_owner_id IN (resolved_ids)` AND `general_meeting_id`.
3. For each found `BallotSubmission`, fetch the `Vote` rows and build the ballot item as before.
4. Include `submitter_email` and `proxy_email` from `BallotSubmission` in the response so the frontend can render the "submitted by" note.

**Modified `MyBallotResponse`** (`backend/app/schemas/voting.py`):
- Add `submitter_email: str` and `proxy_email: str | None` to `BallotItem`.

#### Frontend changes

**Modified `ConfirmationPage.tsx`**:
- Render "This ballot was submitted by {submitter_email}" note beneath each ballot item.
- When `proxy_email` is set, render "Submitted via proxy by {proxy_email}".

No routing changes — `already_submitted` per lot (existing auth response field) already returns `true` when any `BallotSubmission` exists for that `lot_owner_id`, so co-owners are already routed to the confirmation page.

---

### Slice 7 — Per-Motion Voting Window (US-PMW-01, US-PMW-02)

#### Database changes

**`motions` table** — add one column:

```sql
ALTER TABLE motions
  ADD COLUMN voting_closed_at TIMESTAMPTZ DEFAULT NULL;
```

`NULL` means voting is open for this motion. Non-null means voting was closed at that timestamp.

No foreign key; no cascade. The column is set by `POST /api/admin/motions/{id}/close` and by the meeting-close path.

#### Backend changes

**Modified `Motion` model** (`backend/app/models/motion.py`):
- Add `voting_closed_at: Mapped[datetime | None]` with `nullable=True`.

**New endpoint:** `POST /api/admin/motions/{id}/close`
- Auth: `require_admin`.
- Validates:
  - Motion exists → 404 if not.
  - Motion `is_visible = True` → 409 if hidden ("Motion must be visible before closing").
  - `voting_closed_at IS NULL` → 409 if already closed.
  - Meeting `effective_status == "open"` → 409 if meeting is closed.
- Sets `motion.voting_closed_at = datetime.now(UTC)`.
- Does NOT immediately create absent `Vote` rows; the tally query handles absence by detecting lots with no submitted vote before `voting_closed_at` (same approach as meeting-level absent tallies).
- Returns updated `MotionDetail`.

**Modified `close_general_meeting`** (`admin_service.py`):
- After setting `meeting.status = closed`, set `voting_closed_at = meeting.closed_at` on all motions in the meeting where `voting_closed_at IS NULL`.

**Modified `submit_ballot`** (`voting_service.py`):
- Before recording votes, check each motion in `inline_votes` and `multi_choice_votes` against `Motion.voting_closed_at`.
- If any targeted motion has `voting_closed_at IS NOT NULL`, return 422: `"Voting has closed for motion: {motion_number}"` for each such motion.

**Modified `toggle_motion_visibility`** (`admin_service.py`):
- When hiding (`is_visible = False`): if `voting_closed_at IS NOT NULL`, return 409 ("Cannot hide a closed motion").

**Modified tally calculation** (`admin_service.py` → `get_general_meeting_detail`):
- For each motion, use `voting_closed_at` (or `meeting.closed_at` if `voting_closed_at` is null) as the cutoff when counting absent lots.
- A lot is absent for a motion if it has no `Vote` row with `status = submitted` and `created_at <= motion_voting_closed_at`.

**Modified `MotionOut`** (`backend/app/schemas/voting.py`):
- Add `voting_closed_at: datetime | None`.

**Modified `MotionDetail`** (`backend/app/schemas/admin.py`):
- Add `voting_closed_at: datetime | None`.

#### Frontend changes

**Modified `list_motions` response handling** in `VotingPage.tsx`:
- When `motion.voting_closed_at` is non-null:
  - Disable all vote controls for that motion.
  - Show "Voting closed" label instead of vote buttons.
- Polling interval (already 10 s) picks up newly closed motions automatically.
- Exclude motions with `voting_closed_at IS NOT NULL` and no voter answer from the progress bar denominator.

**Modified motion management table** in `AdminMeetingDetailPage.tsx`:
- Add "Close Motion" button in Actions column for each visible motion on an open meeting.
- Button disabled when `voting_closed_at IS NOT NULL`; replaced with a "Closed" badge in that case.
- Clicking "Close Motion" shows a confirmation dialog; on confirm calls `POST /api/admin/motions/{id}/close`.

**New API client function** (`frontend/src/api/admin.ts`):
- `closeMotion(motionId)` calling `POST /api/admin/motions/{id}/close`.

---

## Security Considerations

- **Authentication**: all new admin endpoints (`POST /api/admin/general-meetings/{id}/enter-votes`, `POST /api/admin/motions/{id}/close`) are protected by `require_admin`. The voter `GET /api/general-meeting/{id}/motions` and `POST /api/general-meeting/{id}/submit` changes are already session-protected.
- **Input validation**: `enter-votes` validates `lot_owner_ids` against the building's lot roster; foreign IDs are rejected with 422. `option_limit` enforcement is handled by the existing `submit_ballot` service.
- **Session/cookies**: no changes to session handling.
- **Secrets**: no new credentials required. `qrcode.react` is a client-side library; no server secrets involved.
- **Rate limiting**: the existing ballot submit rate limiter (10 req/min per email) applies to `submit_ballot` called by the new admin vote entry path. The admin session is already authenticated, so no additional rate limiting is needed on `enter-votes`.
- **Data exposure**: `get_my_ballot` broadening (Slice 6) only returns data for lots the authenticated voter is legitimately associated with (same `lot_owner_id` resolution as `list_motions`). No cross-building or cross-meeting data is exposed.

---

## Files to Change

| File | Change |
|------|--------|
| `backend/app/models/ballot_submission.py` | Add `submitted_by_admin` column |
| `backend/app/models/lot_owner.py` | Add `given_name`, `surname` columns |
| `backend/app/models/lot_proxy.py` | Add `given_name`, `surname` columns |
| `backend/app/models/motion.py` | Add `voting_closed_at` column; expand `MotionType` if needed |
| `backend/app/models/motion_option.py` | Add `outcome` column |
| `backend/app/models/vote.py` | Add `against` to `VoteChoice` enum |
| `backend/alembic/versions/` | New migration: all schema changes above |
| `backend/app/routers/admin.py` | Add `POST /admin/general-meetings/{id}/enter-votes`, `POST /admin/motions/{id}/close` endpoints |
| `backend/app/routers/voting.py` | Modify `submit_ballot_endpoint` to check `voting_closed_at`; modify `list_motions` to return `voting_closed_at` and per-option choices |
| `backend/app/schemas/admin.py` | Add `AdminVoteEntryRequest/Result`, extend `LotOwnerCreate/Update/Out`, `SetProxyRequest`, `MotionDetail`, option tally schemas |
| `backend/app/schemas/voting.py` | Update `MultiChoiceVoteItem` shape; add `voting_closed_at` to `MotionOut`; add `submitter_email`/`proxy_email` to `MyBallotResponse` |
| `backend/app/services/admin_service.py` | Add `enter_votes_for_meeting`, `compute_multi_choice_outcomes`; modify `close_general_meeting`, `toggle_motion_visibility`, `get_general_meeting_detail`, lot owner/proxy CRUD functions, import functions |
| `backend/app/services/voting_service.py` | Modify `submit_ballot` (motion-close check, new multi-choice vote shape); modify `get_my_ballot` (broader lot owner query) |
| `backend/app/services/email_service.py` | Add `Submitted By` column to CSV; add outcome labels to email template |
| `frontend/package.json` | Add `qrcode.react` dependency |
| `frontend/src/api/admin.ts` | Add `enterInPersonVotes`, `closeMotion` functions |
| `frontend/src/pages/admin/AdminMeetingDetailPage.tsx` | Add "Enter In-Person Votes" button + `AdminVoteEntryPanel`; add "Close Motion" button on motion rows; add QR code display |
| `frontend/src/pages/admin/AdminVoteEntryPanel.tsx` | New component (Slice 1 steps 1 + 2) |
| `frontend/src/components/AgmQrCode.tsx` | New component (Slice 5) |
| `frontend/src/components/AgmQrCodeModal.tsx` | New component (Slice 5) |
| `frontend/src/pages/voter/VotingPage.tsx` | Update multi-choice rendering; disable controls for `voting_closed_at`; update progress bar denominator |
| `frontend/src/pages/voter/ConfirmationPage.tsx` | Show "submitted by" note (Slice 6); show per-option choices for multi-choice (Slice 3) |
| `frontend/src/pages/admin/BuildingDetailPage.tsx` | Add given name/surname fields to Add and Edit lot owner forms; add Name column to table |
| `frontend/tests/msw/handlers.ts` | Add MSW handlers for new endpoints |

---

## Test Cases

### Slice 1 — Admin Vote Entry

**Unit / Integration:**
- Happy path: admin submits votes for 3 lots; all get `BallotSubmission(submitted_by_admin=True)` + `Vote` rows.
- Skip already-submitted: one lot already has an app submission; it is skipped; the other two are recorded; `skipped_count = 1`.
- In-arrear lot + general motion: vote recorded as `not_eligible`; `special` motion vote recorded normally.
- Multi-choice option_limit enforced: sending 4 options when limit is 3 returns 422.
- Closed meeting: returns 409.
- Unknown lot_owner_id: returns 422.

**E2E:**
- Admin opens "Enter In-Person Votes", selects 2 lots, fills the grid, submits; both lots appear as voted in the results.
- Lot already submitted via app does not appear in the lot selection panel.

### Slice 2 — Lot Owner Names

**Unit / Integration:**
- Add lot owner with name: `given_name`/`surname` persisted and returned.
- Add lot owner without name: succeeds; fields are null.
- CSV import with name columns: names imported correctly.
- CSV import without name columns: import succeeds; names are null.
- Set proxy with name: name persisted on `LotProxy`.

**E2E:**
- Admin adds a lot owner with a name; name appears in the lot owner table.

### Slice 3 — Multi-Choice Per-Option For/Against/Abstain

**Unit / Integration:**
- Submit with For on 2 options (limit 2): 2 `Vote(choice=selected)` rows with `motion_option_id` set.
- Submit with Against on 1 option: 1 `Vote(choice=against, motion_option_id=...)` row.
- Submit with For > option_limit: returns 422.
- Submit with all options left blank (abstain entire motion): 1 `Vote(choice=abstained, motion_option_id=None)`.
- `get_my_ballot` returns per-option choices including `against`.

**E2E:**
- Voter sees For/Against/Abstain buttons per option; For buttons disable at limit; Against does not consume limit.

### Slice 4 — Multi-Choice Pass/Fail Outcome

**Unit / Integration:**
- All options below 50% against threshold, top N by for-votes: top N pass, rest fail.
- One option has >50% against: it fails regardless of for-votes.
- Tie at boundary (positions N and N+1 have equal for-votes): both flagged `tie`, neither promoted to pass.
- `compute_multi_choice_outcomes` called on meeting close; outcomes stored in `motion_options.outcome`.
- `get_general_meeting_detail` returns outcome on each option tally item.

**E2E:**
- Close a meeting with a multi-choice motion; admin results page shows Pass/Fail/Tie badges.

### Slice 5 — QR Code

**Unit / Integration:**
- `AgmQrCode` renders a `<canvas>` element when given an `agmId`.
- `AgmQrCodeModal` renders with Download and Print buttons.
- Logo `imageSettings` prop is set when `logoUrl` is non-empty; absent when empty.

**E2E:**
- Admin AGM detail page shows QR code; clicking enlarges it; Download button triggers file download.

### Slice 6 — Cross-Owner Ballot Visibility

**Unit / Integration:**
- Voter A submits ballot for Lot 101. Voter B (different email, same lot via `LotOwnerEmail`) authenticates; `get_my_ballot` returns Lot 101's ballot with `submitter_email = voter_a@example.com`.
- Proxy authenticates after lot owner submitted; same result with `submitter_email` set.
- Voter has no associated lots with submissions: `get_my_ballot` returns empty list.

**E2E:**
- Co-owner authenticates after ballot submitted by other owner; confirmation page shows ballot with "submitted by" note.

### Slice 7 — Per-Motion Voting Window

**Unit / Integration:**
- Close a visible motion: `voting_closed_at` is set; subsequent submit for that motion returns 422.
- Close an already-closed motion: 409.
- Close a hidden motion: 409.
- Close meeting with open motions: all motions get `voting_closed_at = meeting.closed_at`.
- Tally for per-motion-closed motion counts only votes submitted before `voting_closed_at`.
- `list_motions` returns `voting_closed_at` on each motion.
- Attempt to hide a closed motion: 409.

**E2E:**
- Admin closes Motion 2 on an open meeting; voter page immediately shows Motion 2 as locked (after next poll); voter can still vote on Motion 3.

---

## Schema Migration Required

Yes — a single Alembic migration covers all schema changes:
1. `ballot_submissions.submitted_by_admin` (BOOLEAN NOT NULL DEFAULT FALSE)
2. `lot_owners.given_name` (VARCHAR nullable), `lot_owners.surname` (VARCHAR nullable)
3. `lot_proxies.given_name` (VARCHAR nullable), `lot_proxies.surname` (VARCHAR nullable)
4. `motions.voting_closed_at` (TIMESTAMPTZ nullable)
5. `motion_options.outcome` (VARCHAR nullable, CHECK IN ('pass','fail','tie'))
6. `votechoice` enum: add `'against'` value

All changes are additive (new nullable columns, new enum value) and backward-compatible with existing data.

---

## Parallelisation Plan

The seven features decompose into independent slices with one dependency:

| Slice | Depends on |
|-------|-----------|
| Slice 1 — Admin vote entry | None (uses existing `submit_ballot` service) |
| Slice 2 — Lot owner names | None |
| Slice 3 — Multi-choice For/Against/Abstain | None (schema change to `VoteChoice` enum is additive) |
| Slice 4 — Multi-choice pass/fail outcome | Slice 3 (needs `against` vote rows to compute against threshold) |
| Slice 5 — QR code | None |
| Slice 6 — Cross-owner ballot visibility | None |
| Slice 7 — Per-motion voting window | None |

Slices 1, 2, 3, 5, 6, and 7 can be built in parallel on separate branches. Slice 4 must be built after Slice 3 merges (it needs the `against` VoteChoice value).

All slices that include schema changes (1, 2, 3, 4, 7) require their own Neon DB branch and Vercel env var setup per the CLAUDE.md migration protocol. Slices 5 and 6 require no schema changes and can use the `preview` Neon branch directly.
