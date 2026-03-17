# PRD: Vote Eligibility and Multi-Lot Voting

## Introduction

This PRD extends the AGM voting system with a richer model of voter identity and eligibility. The current system authenticates by lot number + email, issues one ballot per email per AGM, and treats email as a single field on a lot owner. This creates problems in practice:

1. Multiple people may legitimately represent the same lot (e.g., two co-owners with different emails).
2. Owners may have many lots and wish to vote for only some of them now and the rest later.
3. Lots with unpaid levies (in arrears) are legally restricted from voting on General Motions but may still vote on Special Motions.

This PRD redesigns authentication to be email-only, moves to per-lot ballot submissions, supports multiple emails per lot, introduces financial position on lots, and adds motion type classification.

---

## Goals

- Allow any authorised email address associated with a lot to authenticate and vote for that lot
- Authenticate voters by email only — no lot number required
- Ensure each lot submits at most one ballot per AGM, regardless of which email was used
- Allow voters with multiple lots to submit ballots for a subset and return for the remaining lots
- Restrict in-arrear lots to voting on Special Motions only; General Motion votes for in-arrear lots are not recorded
- Classify each motion as General or Special; display this to voters
- Accept lot owner import rows that have an empty email (lot is created without an email contact)
- Show a lot's financial position on its admin detail view

---

## User Stories

### US-V01: Add `motion_type` field to motions

**Description:** As a developer, I need motions to carry a type (General or Special) so the system can enforce eligibility rules.

**Acceptance Criteria:**
- [ ] Add `motion_type` column to `motions` table: `'general'` | `'special'`, NOT NULL, default `'general'`
- [ ] Migration generated and runs cleanly against dev and test DBs
- [ ] Existing motions are migrated with `motion_type = 'general'`
- [ ] `motion_type` is returned in all motion API responses (`GET /api/agms/{id}`, voting page endpoint)
- [ ] AGM creation form allows setting `motion_type` per motion (dropdown or toggle: General / Special)
- [ ] `motion_type` is included in the Excel motion import (column `Motion Type`); accepted values are `General` and `Special` (case-insensitive); missing or blank values default to `General`
- [ ] Typecheck/lint passes

---

### US-V02: Add `financial_position` field to lot owners

**Description:** As a developer, I need lot owners to carry a financial position so the system can restrict in-arrear lots from voting on General Motions.

**Acceptance Criteria:**
- [ ] Add `financial_position` column to `lot_owners` table: `'normal'` | `'in_arrear'`, NOT NULL, default `'normal'`
- [ ] Migration generated and runs cleanly
- [ ] Existing lot owners are migrated with `financial_position = 'normal'`
- [ ] `financial_position` is included in lot owner import (column `Financial Position` or `financial_position`); accepted values `Normal`, `In Arrear` (case-insensitive); blank/missing defaults to `normal`
- [ ] `financial_position` is returned in admin lot owner API responses
- [ ] Typecheck/lint passes

---

### US-V03: Refactor lot owner emails to a separate `LotOwnerEmail` table

**Description:** As a developer, I need to support multiple email addresses per lot so that any authorised contact can vote for that lot.

**Acceptance Criteria:**
- [ ] New table `lot_owner_emails` with columns: `id` (UUID PK), `lot_owner_id` (FK → `lot_owners.id` CASCADE DELETE), `email` (String, nullable)
- [ ] Unique constraint on `(lot_owner_id, email)` (two nulls are allowed — DB-level nulls are not equal)
- [ ] Index on `email` for fast lookup by email during authentication
- [ ] `email` column removed from `lot_owners` table
- [ ] Existing `lot_owners.email` values migrated to new `lot_owner_emails` rows
- [ ] `AGMLotWeight.voter_email` column removed — lot weights are now associated via `lot_owner_id` alone; `voter_email` is stored on `BallotSubmission` only (for audit)
- [ ] Migration generated and runs cleanly
- [ ] Typecheck/lint passes

---

### US-V04: Update lot owner import to support multiple emails and empty emails

**Description:** As a meeting host, I want the lot owner import to accept multiple email rows for the same lot and allow rows with no email, so I can import exactly what the strata roll contains.

**Acceptance Criteria:**
- [ ] Import file may contain multiple rows with the same `Lot#` / `lot_number` and different emails — all emails are stored as separate `LotOwnerEmail` records for that lot
- [ ] If multiple rows share the same `Lot#`, the `UOE2`/`unit_entitlement` and `Financial Position` values are taken from the **first** row for that lot; subsequent rows for the same lot need only the email (other columns are ignored after the first row)
- [ ] A row with a blank or missing `Email` column is accepted: the lot is created/updated as normal but no `LotOwnerEmail` row is created for that blank value
- [ ] Import upsert behaviour (by lot number within building) is preserved — re-importing updates entitlement and financial position, and replaces the full set of emails for that lot (delete all existing emails for the lot then insert the new set)
- [ ] Duplicate emails within the same lot in the import file are silently deduplicated (not rejected)
- [ ] Lots absent from the import file are deleted as before
- [ ] Successful import shows count of lots imported and total emails recorded
- [ ] Typecheck/lint passes

---

### US-V05: Email-only authentication returning a list of lots

**Description:** As a lot owner, I want to enter only my email address to authenticate, so I don't need to know my lot number.

**Acceptance Criteria:**
- [ ] `POST /api/auth/verify` request body changes to: `{ email, building_id, agm_id }` — `lot_number` is removed
- [ ] The endpoint looks up all `LotOwnerEmail` records matching the given `email` (exact match, case-sensitive), then resolves the associated `LotOwner` records for the given `building_id`
- [ ] If no matching email + building combination is found, return 401 with message "Email address not found for this building"
- [ ] Response includes a list of lots the email is authorised to vote for: each entry contains `lot_owner_id`, `lot_number`, `financial_position`, and `already_submitted` (true if a `BallotSubmission` exists for that lot + AGM)
- [ ] Response also includes `agm_status` and `voter_email` (unchanged)
- [ ] Session is scoped to `voter_email` + `building_id` + `agm_id` (unchanged); lots are resolved dynamically from the email at request time, not stored in the session
- [ ] `already_submitted` is computed per lot (not per email) — each lot's ballot is tracked independently
- [ ] Typecheck/lint passes

---

### US-V06: Lot selection UI before voting

**Description:** As a lot owner, I want to see a list of lots associated with my email and choose which ones to cast votes for, so I can vote for multiple lots at once or split them across sessions.

**Acceptance Criteria:**
- [ ] After successful authentication, the frontend shows a lot selection screen titled "Your Lots"
- [ ] Each lot is shown with: lot number, financial position badge ("In Arrear" when applicable), proxy badge ("Proxy for Lot N" when applicable), and "Already submitted" badge when applicable
- [ ] **Multi-lot voters (2+ lots):** Each lot row renders a checkbox; voters can select which lots to include in the current vote session
  - [ ] All pending (not-yet-submitted) lots are checked by default on mount
  - [ ] Already-submitted lots render a disabled, unchecked checkbox — they cannot be re-selected
  - [ ] "Start Voting" is disabled when no checkboxes are selected (i.e. `selectedIds.size === 0`)
  - [ ] If the user somehow triggers "Start Voting" with nothing selected, an inline validation alert (`<p role="alert">Please select at least one lot</p>`) is displayed
  - [ ] On submit, `sessionStorage['meeting_lots_${meetingId}']` is written with only the `lot_owner_id` values of the checked lots (as a JSON array); this is the list the voting page will use
- [ ] **Single-lot voters (exactly 1 lot):** No checkbox is rendered — existing UX is preserved unchanged
- [ ] Subtitle shows "You are voting for N lot(s)" where N is the count of currently-selected (checked) lots, updating dynamically as checkboxes change; for single-lot it shows the fixed pending count
- [ ] If all lots have already been submitted, a "View Submission" button is shown and no "Start Voting" button is rendered
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-V07: Per-lot ballot submission

**Description:** As a developer, I need ballot submissions to be keyed per lot (not per email) so that each lot votes exactly once regardless of which email authenticated.

**Acceptance Criteria:**
- [ ] `BallotSubmission` gains a `lot_owner_id` column (FK → `lot_owners.id`)
- [ ] Unique constraint changed from `(agm_id, voter_email)` to `(agm_id, lot_owner_id)`
- [ ] `voter_email` column is kept on `BallotSubmission` for audit purposes but is no longer the uniqueness key
- [ ] `POST /api/agm/{id}/vote` now accepts `lot_owner_ids: list[UUID]` — the list of lots to submit ballots for (all receive the same vote choices in one request)
- [ ] Submitting for a lot that has already submitted returns 409: "A ballot has already been submitted for lot {lot_number}"
- [ ] Submitting for a lot that does not belong to the authenticated email returns 403
- [ ] Vote tallies are computed by joining `ballot_submissions` → `votes` → `agm_lot_weights` on `lot_owner_id` and summing `unit_entitlement_snapshot` per vote category per motion
- [ ] Draft votes are stored per `lot_owner_id` per AGM (not per `voter_email`); draft state is restored per lot when the user re-authenticates with the same email
- [ ] Migration generated and runs cleanly; existing ballot submissions migrated where possible (populate `lot_owner_id` from `voter_email` lookup)
- [ ] Typecheck/lint passes

---

### US-V08: In-arrear lot voting restrictions

**Description:** As a lot owner with in-arrear lots, the system records `not_eligible` for General Motions at the **backend per-lot** level. The frontend does not block or disable General Motion buttons — a voter with mixed lots (some financial, some in arrears) can vote on General Motions for their financial lots without restriction.

**Acceptance Criteria:**
- [ ] General Motion vote buttons are **fully interactive** for all voters — the frontend does NOT disable or grey out buttons based on financial position
- [ ] No blocking modal is shown; the frontend does not prevent vote submission for in-arrear lots on General Motions
- [ ] An informational amber banner (`role="note"`, `data-testid="arrear-banner"`) is shown above the motions list whenever any selected lot is in arrear:
  - [ ] If all selected lots are in arrear: "All your selected lots are in arrear. You may only vote on Special Motions — General Motion votes will be recorded as not eligible."
  - [ ] If some (but not all) selected lots are in arrear: "Some of your selected lots are in arrear. Your votes on General Motions will not count for in-arrear lots — they will be recorded as not eligible. Votes for all other lots will be recorded normally."
  - [ ] Banner updates immediately when the voter toggles lot checkboxes (multi-lot voters)
  - [ ] Banner is not shown when no selected lots are in arrear
- [ ] The "In Arrear" badge is still shown on the lot in the sidebar (informational only)
- [ ] Special Motion rows are fully interactive for all lots (normal and in-arrear)
- [ ] `VoteChoice` enum gains a new value: `not_eligible` — this is the value recorded for in-arrear lots on General Motions
- [ ] On ballot submission, the backend records `not_eligible` for any General Motion vote from an in-arrear lot (enforced via `financial_position_snapshot` on `AGMLotWeight`), regardless of what the frontend sends
- [ ] The `financial_position` snapshotted in `AGMLotWeight` at AGM creation time is used to determine eligibility — not the live `lot_owners.financial_position`; `financial_position_snapshot` column exists on `AGMLotWeight`
- [ ] Confirmation screen shows "Not eligible" for `not_eligible` votes on General Motions for in-arrear lots
- [ ] Admin tally for each motion includes a separate `not_eligible` category (voter count + entitlement sum) alongside yes / no / abstained / absent
- [ ] Migration: add `not_eligible` to `VoteChoice` enum; runs cleanly against dev and test DBs
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-V09: Partial lot submission and resume

**Description:** As a lot owner with multiple lots, I want to submit a ballot for some of my lots now and return later to vote for the rest, so I can spread the process across time if needed.

**Acceptance Criteria:**
- [ ] After submitting for a subset of lots, the confirmation screen shows: the lots just submitted (with their votes), and a list of remaining unsubmitted lots with a "Vote for remaining lots" button
- [ ] Clicking "Vote for remaining lots" returns the user to the lot selection screen pre-populated with only the unsubmitted lots checked
- [ ] When the voter re-authenticates with the same email later, already-submitted lots are shown as non-interactive (with a "View submission" link) and unsubmitted lots are shown as selectable
- [ ] There is no limit on how many times a voter can split or resume their submissions
- [ ] Once a lot has been submitted its ballot is immutable — re-authentication does not allow changing a submitted lot's votes
- [ ] If the AGM closes while a voter has unsubmitted lots, those lots are recorded as absent
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-V10: Show financial position on admin lot owner detail page

**Description:** As a meeting host, I want to see each lot's financial position in the admin portal so I can verify eligibility before an AGM.

**Acceptance Criteria:**
- [ ] The lot owner row in the admin building detail page shows a "Financial Position" column: "Normal" or "In Arrear"
- [ ] "In Arrear" lots display a visible badge/tag to draw attention
- [ ] The lot owner edit form includes a "Financial Position" dropdown (Normal / In Arrear); updating it saves correctly
- [ ] The lot owner add form includes the same "Financial Position" dropdown (default: Normal)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-V12: Show motion type indicator on admin results page

**Description:** As a meeting host, I want to see a "General" or "Special" badge on each motion in the admin results/report view so I can easily distinguish motion types when reviewing tallies — consistent with the voter-facing voting page.

**Acceptance Criteria:**
- [ ] Each motion row in the admin results report (`AGMReportView` component) shows a "General" or "Special" badge next to the motion title, using the same `motion-type-badge` / `motion-type-badge--general` / `motion-type-badge--special` CSS classes as the voter voting page (`MotionCard`)
- [ ] `motion_type` is already returned in the admin meeting detail API response (`GET /api/admin/general-meetings/{id}`) — no backend changes required
- [ ] The badge is visible for both open and closed meetings
- [ ] Typecheck/lint passes

---

### US-V11: Show emails list on admin lot owner detail page

**Description:** As a meeting host, I want to see all email addresses associated with each lot in the admin portal so I can verify and manage contact details.

**Acceptance Criteria:**
- [ ] The lot owner row or detail view in the admin building detail page shows all associated email addresses (comma-separated or as a list)
- [ ] Admin can add an additional email address to a lot via a form field
- [ ] Admin can remove an email address from a lot (with a confirmation prompt); a lot may end up with zero emails
- [ ] The lot owner import (US-V04) is reflected correctly — re-importing updates both the lot fields and its email set
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

## Functional Requirements

- FR-V1: `Motion.motion_type` is a non-nullable enum: `'general'` | `'special'`. Default is `'general'`. Immutable after AGM creation (same as all other motion fields).
- FR-V2: `LotOwner.financial_position` is a non-nullable enum: `'normal'` | `'in_arrear'`. Default is `'normal'`. Can be updated via import, manual edit, or admin form.
- FR-V3: A new `lot_owner_emails` table stores zero or more email addresses per lot. The `email` column on `lot_owners` is removed. Authentication looks up voters by email in `lot_owner_emails`, not in `lot_owners`.
- FR-V4: Authentication request is `{ email, building_id, agm_id }`. The response lists all lots the email is authorised to vote for, with per-lot `already_submitted` status. A 401 is returned if the email has no association with any lot in the given building.
- FR-V5: Ballot submission uniqueness is enforced per `(agm_id, lot_owner_id)`. A second submission for the same lot returns 409. `voter_email` is stored on the submission for audit purposes only.
- FR-V6: When a voter submits for multiple lots at once (`POST /api/agm/{id}/vote` with `lot_owner_ids: list[UUID]`), all listed lots receive identical vote records. Any lot in the list that has already submitted is rejected (the entire request fails; no partial commit).
- FR-V7: For in-arrear lots, the backend records `not_eligible` on General Motions at submission time, regardless of what choice (if any) the voter made on the frontend. The frontend does not block or disable General Motion buttons — in-arrear restriction is enforced per-lot at the backend only.
- FR-V8: `AGMLotWeight` gains a `financial_position_snapshot` column that captures each lot's financial position at AGM creation time. This snapshot — not the live `lot_owners.financial_position` — governs in-arrear eligibility for votes on that AGM.
- FR-V9: Draft votes are stored per `(lot_owner_id, agm_id)`. Each lot has its own draft state. Re-authenticating with the same email restores drafts for all unsubmitted lots.
- FR-V10: Import rows with a blank `Email` column create/update the lot without adding an email entry. This does not cause a validation error.
- FR-V11: Import rows with the same `Lot#` and different `Email` values are treated as one lot with multiple emails. The lot's `unit_entitlement` and `financial_position` are taken from the first row encountered. The full set of emails for that lot is replaced on each import.
- FR-V12: The lot selection screen defaults to all unsubmitted lots selected. The user may deselect lots and submit for only the selected subset.
- FR-V13: Vote tallies (for results report and live tally) sum `unit_entitlement_snapshot` by joining `ballot_submissions` → `votes` on `lot_owner_id`. The email-based grouping that previously summed entitlements per email is removed.

---

## Non-Goals

- No proxy voting — a voter cannot designate another email to vote on their behalf
- No per-lot different vote choices within the same submission — all lots selected in one submission receive the same votes
- No public-facing display of financial position to other voters
- No automatic promotion from 'in_arrear' to 'normal' based on payment data
- No PropertyIQ sync changes — financial position sync from external system is out of scope
- No change to session expiry or session management behaviour beyond what is required

---

## Design Considerations

- The lot selection screen should be lightweight and fast to complete — lot owners at an AGM may be on mobile. Use a simple checklist with clear lot numbers and status badges.
- Financial position badges: "In Arrear" should use a distinct colour (e.g., amber or red) to stand out from "Normal" (grey/green).
- When the user is voting for a mix of normal and in-arrear lots, the voting page shows: (a) the "In Arrear" badge on affected lots in the sidebar, and (b) an amber informational banner above the motions list explaining the eligibility impact. General Motions are NOT locked or disabled — all motion buttons remain interactive. The backend enforces per-lot eligibility at submission time.
- Confirmation screen: if the submission covered multiple lots, show the lot number alongside each motion row, or group by lot.

---

## Technical Considerations

- **Migration order matters:** Remove `lot_owners.email` only after migrating existing email values to `lot_owner_emails`. `AGMLotWeight.voter_email` can be removed in a separate migration step.
- **Auth service:** `auth_service.create_session` signature does not need to change — session is still scoped to `voter_email + building_id + agm_id`. Lot lookup happens at each request from the session's `voter_email`.
- **Vote submission endpoint:** The `POST /api/agm/{id}/vote` endpoint currently accepts votes for a single voter. It must be extended to accept `lot_owner_ids: list[UUID]` and create one `BallotSubmission` per lot in a single transaction. Partial failure (any lot already submitted) must roll back the entire transaction.
- **Tally query:** The existing tally joins on `voter_email` must be replaced with joins on `lot_owner_id`. The email-based entitlement grouping (`SUM(entitlement) WHERE voter_email = ?`) is replaced with a direct per-lot join.
- **Backward compatibility of API:** The auth endpoint's request body changes (removes `lot_number`). The existing frontend auth form must be updated. Any E2E test that calls `POST /api/auth/verify` with `lot_number` must be updated.
- **Excel motion import:** The existing `AGM Motion test.xlsx` template does not include a `Motion Type` column. If the column is absent, all motions default to `general`. The import is backward-compatible.

---

## Success Metrics

- An owner with 3 lots and 2 email addresses can authenticate with either email and see all 3 lots
- An owner can submit for 2 lots, then re-authenticate and submit for the third lot in a separate session
- An in-arrear lot's General Motion votes are rejected at the backend even if the frontend sends them
- A lot with no email address is importable and appears in the admin lot owner list
- Vote tallies match the sum of per-lot entitlements for each vote category (no email-based grouping artefacts)

---

## Open Questions

1. When a voter submits for multiple lots at once and some are in-arrear, should the in-arrear lots' General Motions silently abstain, or should the voter be explicitly prompted during the submission confirmation dialog? (Recommendation: show a warning in the confirmation dialog — "General Motions will not be recorded for in-arrear lots X, Y. Confirm?")
2. Should `financial_position` be included in the `AGMLotWeight` snapshot at AGM creation, or should it always reflect the live value? This PRD recommends snapshotting it (consistent with `unit_entitlement`), but if financial positions change frequently mid-AGM, a live lookup may be preferred.
3. What should happen if a voter's email is associated with lots across multiple buildings? The auth request already includes `building_id`, so only lots in the specified building are returned — confirm this is the intended behaviour.
4. Are there any import file format changes needed for the `Financial Position` column — i.e., does the existing `Owners_SBT.xlsx` template need a new column, and who maintains the template?
