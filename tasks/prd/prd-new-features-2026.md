# PRD: New Features 2026

## Introduction

This document captures seven new features for the AGM Voting App: admin vote entry on behalf of in-person voters, lot owner names for admin identification, a per-option For/Against/Abstain split for multi-choice motions on the voter-facing page, a pass/fail outcome algorithm for multi-choice results, a QR code for the voter share link, cross-owner ballot visibility on the confirmation page, and per-motion voting windows.

---

## Goals

- Allow admins to enter votes on behalf of lot owners who voted in person (paper or vocal), without overriding app-submitted ballots
- Store given name and surname for lot owners and proxy contacts for admin identification in reports
- Present multi-choice motion options to voters as individual For/Against/Abstain decisions, matching how voters experience other resolution types
- Determine pass/fail outcomes for multi-choice motions based on a building-entitlement threshold and ranking
- Generate a QR code on the admin AGM detail page that lot owners can scan to enter the voter URL
- Allow all lot owners and proxies associated with a lot to view that lot's submitted ballot on the confirmation page
- Allow admins to manually close voting on individual motions while the overall meeting remains open

---

## User Stories

---

### US-AVE-01: Admin selects lots for in-person vote entry

**Status:** ✅ Implemented

**Description:** As an admin, I want to select which lot owner records I need to enter in-person votes for, so that I only see the relevant rows in the entry grid and avoid a cluttered view with all building lots.

**Acceptance Criteria:**

- [ ] The admin AGM detail page (open meeting only) has an "Enter In-Person Votes" button
- [ ] Clicking the button opens a lot-selection panel listing all lots in the building that have not yet submitted a ballot via the app
- [ ] Lots that have already submitted a ballot via the app are excluded from the selectable list and labelled "App submitted"
- [ ] Admin can check any number of pending lots from the list
- [ ] A "Proceed to vote entry" button is enabled only when at least one lot is checked; clicking it advances to the vote entry grid (US-AVE-02)
- [ ] A "Cancel" button dismisses the panel without saving any state
- [ ] The panel shows lot number and (if available) lot owner name(s) for each lot
- [ ] All existing business rules and restrictions still apply (in-arrear lots, multi-choice option limits, motion visibility)
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AVE-02: Admin enters votes in grid UI

**Status:** ✅ Implemented

**Description:** As an admin, I want a dense grid showing motions as rows and selected lots as columns so I can quickly enter votes for multiple lots across all motions in one view.

**Acceptance Criteria:**

- [ ] The vote entry grid renders a table with one row per visible motion and one column per selected lot
- [ ] Each column header shows the lot number and (if available) the first owner's name
- [ ] Each cell contains a compact vote selector appropriate to the motion type:
  - For `general` and `special` motions: a segmented control or compact dropdown with For / Against / Abstain
  - For `multi_choice` motions: a compact multi-select control that enforces `option_limit`
- [ ] In-arrear lots display a "Not eligible" indicator and disabled controls for `general` and `multi_choice` motion cells; `special` motion cells remain enabled for in-arrear lots
- [ ] A lot column shows a visual "all answered" indicator when every motion in that column has a selection
- [ ] A "Submit votes" button is shown at the bottom of the grid
- [ ] Before submission the admin must confirm: a dialog shows a summary ("Submitting votes for N lot(s) across M motion(s)") with a "Confirm" and "Cancel" button
- [ ] On confirmation, `POST /api/admin/general-meetings/{id}/enter-votes` is called with the selected lot IDs and their choices
- [ ] Motions with no selection for a given lot are recorded as `abstained` at submission time (same as the voter flow)
- [ ] On success, the grid is dismissed and the admin sees a success toast; the affected lots now appear as "App submitted" in the lot list
- [ ] On error, an inline error message is shown without dismissing the grid
- [ ] The entry UI is only available on open meetings; the "Enter In-Person Votes" button is absent for closed or pending meetings
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AVE-03: Admin-submitted ballot is marked distinctly in results

**Status:** ✅ Implemented

**Description:** As an admin reviewing results, I want to see which ballots were entered by an admin on behalf of a voter (rather than self-submitted via the app), so that I can distinguish in-person and app votes in the report.

**Acceptance Criteria:**

- [ ] `BallotSubmission` records created via admin vote entry have `submitted_by_admin = true`; app-submitted records have `submitted_by_admin = false` (default)
- [ ] The admin AGM results section shows an "Admin entered" indicator on rows where `submitted_by_admin = true`
- [ ] The CSV export includes a `Submitted By` column: `"Admin"` when `submitted_by_admin = true`, `"Voter"` otherwise
- [ ] The results report email shows a footnote for each motion listing how many votes were admin-entered
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-LON-01: Lot owner given name and surname

**Status:** Pending

**Description:** As an admin, I want to store a given name and surname for each lot owner so that admin views and reports can identify owners by name rather than lot number alone.

**Acceptance Criteria:**

- [ ] `LotOwner` gains two optional fields: `given_name` (VARCHAR, nullable) and `surname` (VARCHAR, nullable)
- [ ] The Add Lot Owner form in the admin building detail page includes optional "Given name" and "Surname" fields
- [ ] The Edit Lot Owner modal pre-fills existing name values and allows updates
- [ ] The lot owner table on the admin building detail page shows a "Name" column (blank when not set)
- [ ] Names are not shown anywhere in the voter-facing flow (voting page, confirmation page, auth page)
- [ ] The lot owner import (CSV/Excel) accepts optional `given_name` and `surname` columns; rows without these columns import successfully without error (names default to null)
- [ ] `PATCH /api/admin/lot-owners/{id}` accepts `given_name` and `surname` in the request body
- [ ] `GET /api/admin/buildings/{id}/lot-owners` includes `given_name` and `surname` in each `LotOwnerOut` item
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-LON-02: Proxy contact name

**Status:** Pending

**Description:** As an admin, I want to store a name for the proxy contact on a lot so that the results report and admin views can identify proxy representatives by name.

**Acceptance Criteria:**

- [ ] `LotProxy` gains two optional fields: `given_name` (VARCHAR, nullable) and `surname` (VARCHAR, nullable)
- [ ] The Set Proxy dialog on the lot owner detail / edit view includes optional "Given name" and "Surname" fields for the proxy contact
- [ ] `PUT /api/admin/lot-owners/{id}/proxy` accepts `given_name` and `surname` alongside `proxy_email`
- [ ] `GET /api/admin/lot-owners/{id}` returns proxy name fields in the `LotOwnerOut.proxy` object
- [ ] The proxy import (CSV/Excel) accepts optional `proxy_given_name` and `proxy_surname` columns; rows without them import without error
- [ ] Proxy names are not shown in the voter-facing flow
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MC-SPLIT-01: Voter sees per-option For/Against/Abstain on multi-choice motions

**Status:** Pending

**Description:** As a lot owner, I want each option in a multi-choice motion to have its own For / Against / Abstain buttons so that I can express support, opposition, or neutrality for each option individually, consistent with how I vote on other motion types.

**Acceptance Criteria:**

- [ ] On the voter-facing voting page, multi-choice motions render one vote row per option, each with three buttons: **For**, **Against**, **Abstain**
- [ ] The motion card header shows the motion title, description, and a counter: "Select up to N option(s) — X voted For"
- [ ] Voting "For" an option counts towards the `option_limit`; once the limit is reached, all unselected "For" buttons become disabled; already-selected options remain interactive (voter can change to Against or Abstain to free up a slot)
- [ ] Voting "Against" or "Abstain" for an option does NOT consume a selection slot and does NOT count toward the `option_limit`
- [ ] An option with no selection is considered unanswered for progress-bar purposes; selecting any of For/Against/Abstain marks it answered
- [ ] Selecting zero options across all rows is valid — the entire motion is treated as Abstained on submission
- [ ] On submission, each option's choice is sent in `multi_choice_votes[].option_choices: [{option_id, choice}]` where choice is `"for"`, `"against"`, or `"abstained"`
- [ ] The backend records:
  - `choice = "selected"` (maps to "For") with `motion_option_id` set for each option the voter voted For
  - `choice = "against"` with `motion_option_id` set for each option voted Against
  - `choice = "abstained"` with `motion_option_id` set for each option explicitly Abstained or left unanswered
  - A single `choice = "abstained"` row (no `motion_option_id`) when the voter chose Abstain for the entire motion
- [ ] In-arrear lots display all option rows as disabled with a "Not eligible" indicator; submission records `not_eligible` (same as before)
- [ ] The confirmation screen shows each option and the voter's choice (For / Against / Abstained) for that option
- [ ] `GET /api/general-meeting/{id}/my-ballot` returns per-option choices in `BallotVoteItem.option_choices`
- [ ] Admin motion creation/editing flow is unchanged — options, option_limit, and motion type are configured identically to today
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MC-RESULT-01: Multi-choice motion pass/fail outcome

**Status:** Pending

**Description:** As a meeting host, I want the system to automatically determine which options pass and fail on a multi-choice motion so that I can announce the outcome without manually tallying weighted votes.

**Acceptance Criteria:**

- [ ] For each option on a closed multi-choice motion, the system computes `against_entitlement_sum` (sum of UOE for lots that voted Against) as a percentage of `total_building_entitlement`
- [ ] An option **fails** if its `against_entitlement_sum / total_building_entitlement > 0.50`; abstained and absent lots are excluded from the denominator
- [ ] Options that do not fail are ranked descending by their `for_entitlement_sum` (sum of UOE for lots that voted For)
- [ ] The top `option_limit` ranked options **pass** (subject to the fail rule above)
- [ ] If two options are tied at position `option_limit` / `option_limit + 1`, neither is automatically promoted to pass; instead both are flagged with `outcome = "tie"` and the admin results view highlights them with a distinct visual indicator and a note: "Tied position — admin review required"
- [ ] Options that pass are flagged `outcome = "pass"`, options that fail are flagged `outcome = "fail"`, tied options are flagged `outcome = "tie"`; non-multi-choice motions have `outcome = null`
- [ ] The admin AGM results section displays the outcome badge (Pass / Fail / Tie) beside each option row
- [ ] The results report email includes the outcome label per option
- [ ] `GET /api/admin/general-meetings/{id}` returns `tally.options[].outcome: "pass" | "fail" | "tie" | null` for each option
- [ ] Outcome calculation runs when the meeting is closed; re-running the endpoint always reflects the final closed state
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-QR-01: QR code for voter share link on admin AGM detail page

**Status:** Pending

**Description:** As a meeting host, I want to display a QR code for the voter-facing AGM URL on the admin AGM detail page so that I can project or print it for in-person attendees to scan.

**Acceptance Criteria:**

- [ ] The admin AGM detail page shows a QR code encoding the voter URL (`/vote/{agm_id}`) in the page header area or a dedicated "Share" section
- [ ] The QR code is generated entirely client-side (no backend endpoint required); a suitable JS library (e.g., `qrcode.react`) is used
- [ ] The tenant logo (from `BrandingContext.logo_url`) is rendered in the centre of the QR code when `logo_url` is non-empty; when empty, the QR code is rendered without a centre image
- [ ] Clicking the QR code opens a modal with a larger version of the same QR code (with logo) for easier scanning or display on a projector
- [ ] The modal contains a "Download PNG" button that triggers a client-side download of the QR code image (logo included where set); the filename is `agm-qr-{agm_id}.png`
- [ ] The modal contains a "Print" button that calls `window.print()` scoped to the QR image only
- [ ] The modal is dismissible via a close button or clicking outside
- [ ] The QR code is present for both open and closed meetings
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MOV-01: All lot owners and proxies see submitted ballot on confirmation page

**Status:** Pending

**Description:** As a lot owner or proxy who did not submit the original ballot, I want to see the submitted votes for my lot on the confirmation page so that I have a record of how my lot voted regardless of who submitted.

**Acceptance Criteria:**

- [ ] When a voter authenticates for a lot where a ballot has already been submitted (by a different email associated with the same lot, or by a proxy), they are taken to the confirmation page instead of the voting page
- [ ] The confirmation page shows the full per-motion vote breakdown for the lot, regardless of which email originally submitted
- [ ] The confirmation page displays a note: "This ballot was submitted by [submitter_email]" (or "submitted via proxy by [proxy_email]" when `proxy_email` is set on the `BallotSubmission`)
- [ ] If multiple lots are associated with the authenticating voter's email and some have been submitted by others, the confirmation page shows each lot's submission separately (same existing multi-lot layout)
- [ ] `GET /api/general-meeting/{id}/my-ballot` is extended to return ballot data for all lots the authenticated voter is associated with (direct or proxy), not only lots where they are the `voter_email` on the `BallotSubmission`
- [ ] The existing auth flow routing logic (`already_submitted` per lot in the auth response) already handles this: a lot is `already_submitted = true` when any `BallotSubmission` row exists for that `lot_owner_id` in this meeting — this behaviour is unchanged
- [ ] No voter can modify a ballot submitted by another; the confirmation page is always read-only
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-PMW-01: Admin closes a single motion

**Status:** Pending

**Description:** As a meeting host, I want to manually close voting on an individual motion while the overall meeting remains open so that I can freeze a motion's result at the right moment without ending the entire ballot.

**Acceptance Criteria:**

- [ ] Each motion row in the admin motion management table (open meetings only) has a "Close Motion" button in the Actions column
- [ ] Clicking "Close Motion" shows a confirmation dialog: "Close voting on this motion? Lot owners who have not yet submitted will be recorded as absent for this motion. This cannot be undone."
- [ ] Confirming calls `POST /api/admin/motions/{id}/close`
- [ ] On success, the motion row shows a "Closed" badge; the "Close Motion" button is replaced with a static "Closed" indicator
- [ ] A closed motion is immediately locked on the voter-facing voting page: the vote buttons for that motion are disabled and a "Voting closed" label is shown on the motion card
- [ ] Voters who have not submitted a vote for the motion at the time of closure are immediately recorded as absent for that motion (a `Vote` row with `choice = "not_eligible"` is NOT used; instead the tally treats them as absent based on the absence of a submitted vote and the motion's `closed_at` timestamp)
- [ ] `Motion` gains a `voting_closed_at` (TIMESTAMPTZ, nullable) column; `null` means voting is still open for that motion
- [ ] `POST /api/admin/motions/{id}/close` sets `voting_closed_at = now()` on the motion; returns 409 if already closed; returns 409 if the meeting is closed
- [ ] When `POST /api/admin/general-meetings/{id}/close` is called (close the whole meeting), all motions with `voting_closed_at IS NULL` have their `voting_closed_at` set to `closed_at` of the meeting
- [ ] Vote submissions (`POST /api/general-meeting/{id}/submit`) reject any vote for a motion where `voting_closed_at IS NOT NULL`; the endpoint returns 422 with detail `"Voting has closed for motion: {motion_number}"` for each such motion
- [ ] `GET /api/general-meeting/{id}/motions` returns `voting_closed_at` on each `MotionOut` so the frontend can disable controls immediately
- [ ] A motion can only be closed if it is currently visible (`is_visible = true`); attempting to close a hidden motion returns 409 with detail `"Motion must be visible before closing"`
- [ ] A closed motion cannot be hidden again; `PATCH /api/admin/motions/{id}/visibility` returns 409 when attempting to hide a motion with `voting_closed_at IS NOT NULL`
- [ ] The tally for a closed motion counts only votes submitted before `voting_closed_at`; lots with no submitted vote before that timestamp are counted as absent
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-PMW-02: Voter sees per-motion close status in real time

**Status:** Pending

**Description:** As a lot owner on the voting page, I want to see when individual motions have had their voting window closed so that I am not confused by suddenly disabled controls.

**Acceptance Criteria:**

- [ ] The voting page polls `GET /api/general-meeting/{id}/motions` every 10 s (same interval as the existing AGM-status poll)
- [ ] When a motion's `voting_closed_at` becomes non-null in a poll response, that motion's vote controls are immediately disabled and a "Voting closed" label replaces the vote buttons
- [ ] A motion that was already locked (voting_closed_at non-null on initial load) shows the "Voting closed" label from the first render
- [ ] The progress bar denominator excludes motions whose `voting_closed_at` is non-null and for which the voter has not yet voted (those motions are no longer actionable)
- [ ] If the voter has already voted on a motion that subsequently has its `voting_closed_at` set, the motion shows their submitted choice (read-only) as normal
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

## Non-Goals

- Admin vote entry for meetings that are already closed
- Overriding or amending app-submitted ballots via admin vote entry
- Lot owner names shown in any voter-facing surface
- Automatically resolving multi-choice ties (admin must resolve manually)
- QR code customisation beyond logo in centre (no colour or style options)
- Per-motion scheduled auto-close (only manual admin close is supported)
- Reopening a per-motion-closed motion (irreversible once closed)

---

## Technical Considerations

- Feature 1 (admin vote entry) reuses the `submit_ballot` service path with a new `submitted_by_admin` flag on `BallotSubmission`; it does not create a separate ballot model
- Feature 2 (lot owner names) requires an Alembic migration adding nullable columns to `lot_owners` and `lot_proxies`
- Feature 3 (multi-choice split) is a frontend-only rendering change on the voter voting page; backend submission needs a new `option_choices` list format per `multi_choice_votes` item
- Feature 4 (multi-choice result) extends the existing tally calculation in `admin_service`; `outcome` is a computed field derived on read, not stored — or stored and refreshed on meeting close
- Feature 5 (QR code) is purely frontend; `qrcode.react` or equivalent is added as a frontend dependency only
- Feature 6 (cross-owner ballot visibility) is a backend query change to `get_my_ballot` — broaden the lookup to match any `lot_owner_id` the session voter is associated with
- Feature 7 (per-motion voting window) requires a schema migration (new `voting_closed_at` column on `motions`), changes to `submit_ballot` to enforce per-motion close, and changes to the tally query to filter by `voting_closed_at`

---

## Success Metrics

- Admin can enter and submit votes for a selected set of lots for a full motion list in under 2 minutes
- All lot owners and proxy contacts associated with a lot see the submitted ballot when they authenticate after submission
- Pass/fail outcomes are automatically computed on meeting close with no manual admin calculation required
- QR code is scannable and navigates directly to the voter URL with no additional steps

---

## Open Questions

- Should the "against" vote for a multi-choice option be stored as a new `VoteChoice` enum value (`against`) or reuse an existing value? The current `VoteChoice` enum has `yes`, `no`, `abstained`, `not_eligible`, `selected`. Adding `against` (and perhaps renaming `selected` to `for`) is the cleanest approach but requires a migration and enum expansion.
- Should multi-choice outcome (`pass`/`fail`/`tie`) be stored as a column on `motion_options` (computed once on close) or computed on every read? Storing avoids re-computation but requires a migration.
