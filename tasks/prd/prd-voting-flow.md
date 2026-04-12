# PRD: Voting Flow

## Introduction

This document covers the complete voter journey: email OTP authentication, persistent session, lot selection, ballot submission, vote confirmation, proxy voting UX, multi-lot voting, re-voting after admin reveals new motions, and vote eligibility rules for in-arrear lots.

---

## Goals

- Allow any authorised email address associated with a lot to authenticate and vote for that lot via email OTP
- Authenticate voters by email only — no lot number required
- Ensure each lot submits at most one ballot per meeting, regardless of which email was used
- Allow voters with multiple lots to submit ballots for a subset and return for the remaining lots
- Restrict in-arrear lots to voting on Special Motions only; General Motion votes for in-arrear lots are not recorded
- Enable proxy voters to authenticate with their own email and vote on behalf of nominated lots
- Support re-entry voting when admin reveals new motions after a voter has already submitted

---

## User Stories

### US-002: Building selection, meeting list, and past submission review

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to select my building, see all meetings for that building, enter the active voting session, and review my past submissions.

**Acceptance Criteria:**

- [ ] Entry page shows a building dropdown listing buildings with at least one open voting session
- [ ] On selecting a building, a list of all meetings for that building is shown, ordered with the most recent first
- [ ] Each meeting in the list shows: meeting title, meeting date/time, scheduled voting close date/time, and current status (Open / Closed / Pending); all times are displayed in the user's local browser timezone
- [ ] An open meeting shows an "Enter Voting" button that takes the lot owner to authentication (US-003)
- [ ] A closed meeting shows a "View My Submission" button; after successful authentication the confirmation screen is shown if they submitted, or an "You did not submit a ballot for this meeting" message if they were absent
- [ ] A pending meeting shows a "Not yet open" label with no Vote CTA
- [ ] Typecheck/lint passes

---

### US-003: Lot owner authentication (OTP)

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to verify my identity via a one-time email code so the system can confirm I am eligible to vote without requiring a password or lot number.

**Acceptance Criteria:**

- [ ] Lot owner enters only their email address on the auth form (no lot number field)
- [ ] Clicking "Send Verification Code" triggers `POST /api/auth/request-otp`; a 6-digit code is emailed to the address
- [ ] The form transitions to a code-entry step showing "We sent a 6-digit code to {email}"
- [ ] Lot owner enters the 6-digit code and clicks "Verify"; the frontend calls `POST /api/auth/verify` with `{email, code, general_meeting_id}`
- [ ] On valid code: system identifies all lots in that building registered to the same email (direct or proxy); a session is created scoped to that email + building + meeting
- [ ] If the lot owner has already submitted a ballot for this meeting, they are taken directly to the confirmation screen (US-009)
- [ ] If the lot owner has not yet submitted, they are taken to the voting page with a fresh ballot
- [ ] On invalid or expired code: a clear inline error is shown ("Invalid or expired code. Please try again."); the code input is cleared
- [ ] No account creation or password required
- [ ] Typecheck/lint passes

---

### US-OTP-01: Email OTP request

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to enter my email and receive a one-time verification code so I can begin the authentication process without a password.

**Acceptance Criteria:**

- [ ] The auth form shows a single "Email address" field and a "Send Verification Code" button on the first step
- [ ] Submitting with an empty email shows an inline validation error; the API is not called
- [ ] `POST /api/auth/request-otp` accepts `{email, general_meeting_id, skip_email?}` and:
  - [ ] Returns 200 `{"sent": true}` if the meeting exists, regardless of whether the email matches any lot owner (user-enumeration protection)
  - [ ] Generates a cryptographically random 6-digit code (`secrets.randbelow(1_000_000)` zero-padded) and stores it in `auth_otps` with `expires_at = now() + 5 minutes`
  - [ ] Sends an OTP email to the address with subject `"Your AGM Voting Code — {meeting_title}"` unless `skip_email: true` is passed (used by E2E test helpers only)
  - [ ] Deletes any previous OTP rows for the same `(email, meeting_id)` pair before inserting the new one
  - [ ] Returns 404 if `general_meeting_id` does not exist
  - [ ] Returns 422 if the email field is empty or missing
- [ ] The "Send Verification Code" button is disabled and shows "Sending…" while the request is in flight
- [ ] Typecheck/lint passes

---

### US-OTP-02: OTP verification (success)

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to enter my verification code and be authenticated so I can proceed to vote.

**Acceptance Criteria:**

- [ ] After `request-otp` succeeds, the form shows a "Verification code" input (`type="text"`, `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength=6`) and a "Verify" button
- [ ] `POST /api/auth/verify` accepts `{email, code, general_meeting_id}` and:
  - [ ] Looks up the most recent unused, unexpired `AuthOtp` row for `(email, meeting_id)`
  - [ ] If the code matches: marks the OTP as `used = TRUE`, proceeds with lot lookup, session creation, and returns the existing `AuthVerifyResponse` (including `session_token` and per-lot `voted_motion_ids`)
  - [ ] Sets a `meeting_session` cookie on success
- [ ] On success, the page navigates as per existing logic (voting page, confirmation page, or pending message)
- [ ] Typecheck/lint passes

---

### US-OTP-03: OTP expiry (5-minute window)

**Status:** ✅ Implemented

**Description:** As a lot owner, I want the system to reject codes older than 5 minutes so that stale codes cannot be used to authenticate.

**Acceptance Criteria:**

- [ ] OTP codes expire exactly 5 minutes after generation
- [ ] `POST /api/auth/verify` called with an expired code returns 401 `{"detail": "Invalid or expired verification code"}`
- [ ] The frontend shows "Invalid or expired code. Please try again." and clears the code input
- [ ] Expiry is checked server-side against `expires_at` (UTC); client clock is not trusted
- [ ] Typecheck/lint passes

---

### US-OTP-04: Invalid OTP error handling

**Status:** ✅ Implemented

**Description:** As a lot owner, I want clear feedback when I enter the wrong code so I know to try again or request a new one.

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` with a code that does not match, is already used, or has no row returns 401 `{"detail": "Invalid or expired verification code"}` (same message — no oracle)
- [ ] The frontend shows the inline error and clears the code input field
- [ ] Typecheck/lint passes

---

### US-OTP-05: Resend code

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to request a new code if I did not receive the first one or it has expired, so I am not locked out.

**Acceptance Criteria:**

- [ ] A "Resend code" button/link is shown below the code input on step 2 of the auth form
- [ ] Clicking "Resend code" calls `POST /api/auth/request-otp` again with the same email and meeting ID
- [ ] The backend enforces a 60-second minimum interval between OTP requests for the same `(email, meeting_id)` pair; requests within that window return 429 `{"detail": "Please wait before requesting another code"}`
- [ ] The code input is cleared when a resend is triggered
- [ ] The previously issued code is no longer valid after a resend
- [ ] Typecheck/lint passes

---

### US-PS-01: Persistent voter session (skip OTP on return visit)

**Status:** ✅ Implemented

**Description:** As a lot owner, I want my authenticated session to be remembered across browser tab closures so that I do not have to re-enter my email and OTP code every time I open the voting app within the same day.

**Acceptance Criteria:**

- [ ] After a successful OTP verification, the session token is stored in `localStorage` under the key `agm_session_<meetingId>`
- [ ] When a voter navigates to `/vote/<meetingId>/auth` and a valid token exists in `localStorage`, the app calls `POST /api/auth/session` with the stored token instead of showing the OTP form
- [ ] While the session restore request is in flight, a "Resuming your session…" loading indicator is shown; the OTP form does not flash
- [ ] On a successful session restore, the voter is taken directly to the voting page (or confirmation page if all lots are already submitted)
- [ ] `POST /api/auth/session` accepts `{ session_token: string, general_meeting_id: UUID }` and returns the same `AuthVerifyResponse` shape
- [ ] `POST /api/auth/session` returns 401 if the token is not found, expired (> 24 hours old), or the meeting is closed
- [ ] On a 401 response, the stale token is removed from `localStorage` and the normal OTP auth form is shown
- [ ] Sessions expire after 24 hours
- [ ] No new environment variables or secrets are required — the session token uses `secrets.token_urlsafe(32)` stored in the existing `session_records` table
- [ ] Typecheck/lint passes
- [ ] All tests pass at 100% coverage

---

### US-V05: Email-only authentication returning a list of lots

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to enter only my email address to authenticate, so I don't need to know my lot number.

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` request body: `{ email, general_meeting_id, code }` — no `lot_number` field
- [ ] The endpoint looks up all `LotOwnerEmail` records matching the given `email`, then resolves associated `LotOwner` records and `lot_proxy` records for the given building
- [ ] If no matching email + building combination is found, return 401
- [ ] Response includes a list of lots the email is authorised to vote for: each entry contains `lot_owner_id`, `lot_number`, `financial_position`, `already_submitted`, `is_proxy`, and `voted_motion_ids`
- [ ] Response also includes `agm_status`, `voter_email`, `session_token`, and `unvoted_visible_count`
- [ ] `already_submitted` per lot: "has this lot cast a submitted vote on every currently-visible motion?" (set-subset check)
- [ ] All email addresses are normalised to lowercase before storage and before OTP lookup
- [ ] Typecheck/lint passes

---

### US-V06: Lot selection UI before voting

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to see a list of lots associated with my email and choose which ones to cast votes for.

**Acceptance Criteria:**

- [ ] After successful authentication, the frontend shows the lot selection UI
- [ ] Each lot is shown with: lot number, financial position badge, proxy badge ("via Proxy" when applicable), and "Already submitted" badge when applicable
- [ ] **Multi-lot voters (2+ lots):** Each lot row renders a checkbox; all pending (not-yet-submitted) lots are checked by default on mount; already-submitted lots render a disabled, unchecked checkbox; "Start Voting" is disabled when no checkboxes are selected
- [ ] **Single-lot voters (exactly 1 lot):** No checkbox is rendered — existing UX is preserved unchanged
- [ ] In the lot sidebar, four shortcut buttons appear above the lot list for multi-lot voters: **Select All**, **Deselect All**, **Select Proxy Lots** (only shown when the voter has at least one proxy lot), **Select Owned Lots** (only shown when the voter has at least one proxy lot)
- [ ] Submitted lots are excluded from all shortcut button selections
- [ ] On mobile (≤640px) the lot sidebar is collapsible via a toggle button; default state is **collapsed**
- [ ] If all lots have already been submitted, a "View Submission" button is shown and no "Start Voting" button is rendered
- [ ] Typecheck/lint passes

---

### US-PX04: Authentication resolves proxy lots

**Status:** ✅ Implemented

**Description:** As a proxy voter, I want to log in with my own email and see both my own lots and the lots I am nominated to vote for.

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` looks up `LotOwnerEmail` records matching `email` + `building_id` (existing) AND `lot_proxy` records where `proxy_email = email` for lots in the same building
- [ ] Both sets are merged into the `lots` response array; duplicates (where proxy voter also owns the lot) are deduplicated — the lot appears once with `is_proxy: false`
- [ ] Each lot entry in the response includes `is_proxy: bool` — `true` if the email is a nominated proxy for that lot, `false` if the voter owns the lot directly
- [ ] If the voter's email appears only as a proxy (owns no lots in the building), auth succeeds as long as at least one proxy nomination exists
- [ ] If the voter's email appears neither as an owner nor a proxy, return 401 with message "Email address not found for this building"
- [ ] Typecheck/lint passes

---

### US-PX05: Lot selection UI shows proxy label

**Status:** ✅ Implemented

**Description:** As a proxy voter, I want to see which lots are mine and which I am voting for as proxy.

**Acceptance Criteria:**

- [ ] Proxied lots show a "VIA PROXY" badge — badge text is just "via Proxy" (not "Lot 42 via Proxy")
- [ ] Own lots show no proxy badge
- [ ] In-arrear badge still shown per lot regardless of proxy status
- [ ] Already-submitted lots remain greyed out and non-interactive, with their proxy/own label still visible
- [ ] Typecheck/lint passes

---

### US-004: Vote on motions

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to vote yes, no, or abstain on each motion and submit my ballot so I can participate in the meeting.

**Acceptance Criteria:**

- [ ] The voting page header shows: building name, meeting title, meeting date/time, and scheduled voting close date/time (all times in the user's local browser timezone)
- [ ] All visible motions for the meeting are listed in order with title and description
- [ ] Each binary motion has three clearly labelled options: **For**, **Against**, **Abstain**; any option can be deselected back to unanswered at any time before submission
- [ ] Multi-choice motions render per-option For/Against/Abstain rows (see US-MC-SPLIT-01)
- [ ] A progress bar shows how many motions have been answered out of the total (e.g. "4 / 7 motions answered")
- [ ] Every time a lot owner selects or changes an option on a motion, that selection is held in client-side React state; no auto-save to the backend occurs
- [ ] A countdown timer to the scheduled voting close time is shown persistently on the page; the timer is calculated from server time fetched on page load to avoid client clock skew
- [ ] At 5 minutes before the scheduled close time, a prominent warning banner is shown: "Voting closes in 5 minutes — please submit your ballot"
- [ ] If any of the voter's selected lots are in arrear, an informational amber banner is shown above the motions list explaining the eligibility impact
- [ ] The page polls the meeting status every 10 s; if the meeting is found to be closed before the lot owner submits, inputs are immediately disabled and a "Voting has closed" message is shown
- [ ] A "Submit Votes" button is shown at the bottom; drafts are NOT counted in tallies until Submit is clicked
- [ ] On clicking Submit: any motions with no selection are visually highlighted; if there are unanswered motions, a review dialog lists them; if all motions are answered, a standard confirmation dialog is shown
- [ ] Once confirmed and submitted, all inputs are locked and the confirmation screen is shown (see US-009)
- [ ] Votes are immutable after submission — no changes are permitted under any circumstances
- [ ] If a second submission attempt is made, it is rejected with a clear error
- [ ] Typecheck/lint passes

---

### US-V08: In-arrear lot voting restrictions

**Status:** ✅ Implemented

**Description:** As a lot owner with in-arrear lots, the system records `not_eligible` for General Motions at the backend per-lot level.

**Acceptance Criteria:**

- [ ] General Motion vote buttons are **fully interactive** for all voters — the frontend does NOT disable or grey out buttons based on financial position
- [ ] An informational amber banner (`role="note"`, `data-testid="arrear-banner"`) is shown above the motions list whenever any selected lot is in arrear, with appropriate message for all-arrear vs. mixed-arrear scenarios
- [ ] Banner updates immediately when the voter toggles lot checkboxes
- [ ] The "In Arrear" badge is still shown on the lot in the sidebar (informational only)
- [ ] Special Motion rows are fully interactive for all lots
- [ ] `VoteChoice` enum has `not_eligible` value
- [ ] On ballot submission, the backend records `not_eligible` for any General Motion vote from an in-arrear lot (enforced via `financial_position_snapshot` on `GeneralMeetingLotWeight`)
- [ ] Confirmation screen shows "Not eligible" for `not_eligible` votes on General Motions for in-arrear lots
- [ ] Admin tally for each motion includes a separate `not_eligible` category (voter count + entitlement sum) alongside yes / no / abstained / absent
- [ ] Typecheck/lint passes

---

### US-V07: Per-lot ballot submission

**Status:** ✅ Implemented

**Description:** As a developer, I need ballot submissions to be keyed per lot (not per email) so that each lot votes exactly once regardless of which email authenticated.

**Acceptance Criteria:**

- [ ] `BallotSubmission` has a `lot_owner_id` column (FK → `lot_owners.id`)
- [ ] Unique constraint changed from `(agm_id, voter_email)` to `(agm_id, lot_owner_id)`
- [ ] `voter_email` column is kept on `BallotSubmission` for audit purposes
- [ ] `POST /api/general-meeting/{id}/submit` accepts `lot_owner_ids: list[UUID]` — all listed lots receive the same vote choices in one request
- [ ] Submitting for a lot that has already submitted returns 409: "A ballot has already been submitted for lot {lot_number}"
- [ ] Submitting for a lot that does not belong to the authenticated email returns 403
- [ ] Partial failure (any lot already submitted) must roll back the entire transaction
- [ ] Vote tallies are computed by joining `ballot_submissions` → `votes` → `agm_lot_weights` on `lot_owner_id` and summing `unit_entitlement_snapshot` per vote category per motion
- [ ] Typecheck/lint passes

---

### US-PX06: Proxy audit trail on ballot submission

**Status:** ✅ Implemented

**Description:** As a developer, I need to record which ballots were cast by proxy so there is an audit trail in the database.

**Acceptance Criteria:**

- [ ] When `POST /api/general-meeting/{id}/submit` is called, for each `lot_owner_id` in the request: if the authenticated `voter_email` matches a `LotOwnerEmail` for that lot → `BallotSubmission.proxy_email = NULL`; if the authenticated `voter_email` matches `lot_proxy.proxy_email` for that lot → `BallotSubmission.proxy_email = voter_email`
- [ ] 403 if the authenticated voter's email is neither an owner email nor a proxy email for a submitted `lot_owner_id`
- [ ] `proxy_email` is stored in the DB but not exposed in any API response or UI
- [ ] Typecheck/lint passes

---

### US-MC-03: Voter votes on a multi-choice motion

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to select from a list of options on a multi-choice motion so I can participate in elections or preference votes within my AGM ballot.

**Acceptance Criteria:**

- [ ] Multi-choice motions render one vote row per option, each with three buttons: **For**, **Against**, **Abstain** (see also US-MC-SPLIT-01)
- [ ] The motion card header shows the motion title, description, and a counter: "Select up to N option(s) — X voted For"
- [ ] Voting "For" an option counts towards the `option_limit`; once the limit is reached, all unselected "For" buttons become disabled
- [ ] Voting "Against" or "Abstain" for an option does NOT consume a selection slot
- [ ] An option with no selection is considered unanswered for progress-bar purposes
- [ ] Selecting zero options across all rows is valid — the entire motion is treated as Abstained on submission
- [ ] In-arrear lots display all option rows as disabled with a "Not eligible" indicator; submission records `not_eligible`
- [ ] Backend enforces option limit: selecting more options than `option_limit` returns 422
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MC-SPLIT-01: Voter sees per-option For/Against/Abstain on multi-choice motions

**Status:** ✅ Implemented

**Description:** As a lot owner, I want each option in a multi-choice motion to have its own For / Against / Abstain buttons so that I can express support, opposition, or neutrality for each option individually, consistent with how I vote on other motion types.

**Acceptance Criteria:**

- [ ] On the voter-facing voting page, multi-choice motions render one vote row per option, each with three buttons: **For**, **Against**, **Abstain**
- [ ] Voting "Against" or "Abstain" for an option does NOT consume a selection slot and does NOT count toward the `option_limit`
- [ ] An option with no selection is considered unanswered for progress-bar purposes; selecting any of For/Against/Abstain marks it answered
- [ ] On submission, each option's choice is sent in `multi_choice_votes[].option_choices: [{option_id, choice}]` where choice is `"for"`, `"against"`, or `"abstained"`
- [ ] The backend records: `choice = "selected"` (maps to "For") with `motion_option_id` set; `choice = "against"` with `motion_option_id` set; `choice = "abstained"` with `motion_option_id` set for explicitly abstained or unanswered options; a single `choice = "abstained"` row (no `motion_option_id`) when the voter chose Abstain for the entire motion
- [ ] The confirmation screen shows each option and the voter's choice (For / Against / Abstained) for that option
- [ ] `GET /api/general-meeting/{id}/my-ballot` returns per-option choices in `BallotVoteItem.option_choices`
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-V09: Partial lot submission and resume

**Status:** ✅ Implemented

**Description:** As a lot owner with multiple lots, I want to submit a ballot for some of my lots now and return later to vote for the rest.

**Acceptance Criteria:**

- [ ] After submitting for a subset of lots, the confirmation screen shows the lots just submitted (with their votes) and a list of remaining unsubmitted lots with a "Vote for remaining lots" button
- [ ] Clicking "Vote for remaining lots" returns the user to the lot selection screen pre-populated with only the unsubmitted lots checked
- [ ] When the voter re-authenticates with the same email later, already-submitted lots are shown as non-interactive and unsubmitted lots are shown as selectable
- [ ] Once a lot has been submitted its ballot is immutable
- [ ] If the meeting closes while a voter has unsubmitted lots, those lots are recorded as absent
- [ ] Typecheck/lint passes

---

### US-009: Vote confirmation screen

**Status:** ✅ Implemented

**Description:** As a lot owner, I want to see a summary of my submitted votes so I have a record of how I voted.

**Acceptance Criteria:**

- [ ] Immediately after submitting, a read-only confirmation screen is shown
- [ ] Screen shows: building name, meeting title, and the lot owner's email
- [ ] Screen lists each motion title alongside the owner's recorded vote: For, Against, or Abstained; "Not eligible" for in-arrear lots on General Motions; per-option choices for multi-choice motions
- [ ] Screen is shown again if the lot owner re-authenticates (on any device/browser) after submitting
- [ ] If the lot owner authenticates against a closed meeting (regardless of whether they submitted), they are taken to the confirmation screen
- [ ] A "Back to Home" button on the confirmation screen returns the lot owner to the building selection page
- [ ] No ability to change votes on this screen
- [ ] Typecheck/lint passes

---

### US-MOV-01: All lot co-owners see submitted ballot on confirmation page

**Status:** ✅ Implemented

**Description:** As a lot co-owner with a different email than the person who submitted the ballot, I want to see the submitted ballot on the confirmation page so that I can verify what was voted on behalf of my lot.

**Acceptance Criteria:**

- [x] `GET /api/general-meeting/{id}/my-ballot` resolves all `lot_owner_id` values for the authenticated voter's email (direct + proxy) in this building
- [x] Ballot submissions are returned for any of those lots, regardless of which email submitted them
- [x] `LotBallotSummary` includes `submitter_email` (the email that submitted) and `proxy_email` (set if proxy submitted)
- [x] Vote rows are fetched by `lot_owner_id` only — not filtered by `voter_email`
- [x] Confirmation page renders "This ballot was submitted by {submitter_email}" for each lot
- [x] When `proxy_email` is set, renders "Submitted via proxy by {proxy_email}" instead
- [x] Voter with no associated lots gets 404
- [x] All tests pass at 100% coverage
- [x] Typecheck/lint passes

---

### US-MV04: Voter voting page — only show visible motions and already-voted motions

**Status:** ✅ Implemented

**Description:** As a voter, I want to see only the motions that are currently active, plus any motions I have already voted on, so I am not confused by motions that haven't been opened yet.

**Acceptance Criteria:**

- [x] Only motions with `is_visible = true` OR motions the voter has already submitted a vote for are shown
- [x] A motion the voter has already voted on is shown in read-only mode
- [x] "Submit" is enabled when all **currently visible** motions have a selection; previously submitted motions do not need to be re-selected
- [x] If there are no visible motions and no previously submitted motions, the voting page shows a message: "No motions are available yet. Please check back shortly."
- [x] Typecheck/lint passes

---

### US-MV05: Allow re-entry voting for newly visible motions

**Status:** ✅ Implemented

**Description:** As a voter who has already submitted votes, I want to return to the voting page and vote on a newly revealed motion so I am not locked out just because I voted earlier.

**Acceptance Criteria:**

- [x] A voter who has a `BallotSubmission` record for the meeting can still access the voting page if there are visible motions they have not yet voted on
- [x] The `POST /api/auth/verify` response includes `unvoted_visible_count: int`
- [x] If `unvoted_visible_count > 0`, the frontend routes to the voting page, not confirmation, even if the voter has existing submissions
- [x] The voter can submit a vote for the newly visible motion without affecting their previous vote records
- [x] After submitting the new motion's vote, if all visible motions are now voted on, the voter is navigated to the confirmation/summary page
- [x] Typecheck/lint passes

---

## Bug Fixes (Voting Flow)

### BUG-RV-01: Submit button missing after admin makes additional motions visible post-submission

**Status:** ✅ Implemented

**Fix:** Backend recomputes `already_submitted` per lot as "has this lot cast a submitted vote on every currently-visible motion?" (set-subset check). Frontend removes the redundant `!allSubmitted` guard from the Submit button condition.

**Acceptance Criteria:**

- [ ] After initial submission, if an admin makes additional motions visible, a returning voter sees those motions as interactive and the Submit button is present
- [ ] Lots that have fully voted on all currently-visible motions continue to display the "Already submitted" badge
- [ ] All tests pass at 100% coverage

---

### BUG-RV-02: Previously-voted motions shown as unvoted and without prior answer on re-entry

**Status:** ✅ Implemented

**Fix:** Backend extends `MotionOut` with `submitted_choice: VoteChoice | null`. Frontend seeds `choices` state from `submitted_choice` on motions query result. For multi-lot voters where one lot's choice is `not_eligible` and another has a real choice, prefer the non-`not_eligible` value.

**Acceptance Criteria:**

- [ ] When a voter re-enters the voting page after admin has made additional motions visible, motions they previously answered display with their original choice pre-selected
- [ ] `GET /api/general-meeting/{id}/motions` returns `submitted_choice: null` for unvoted motions and the correct `VoteChoice` value for voted motions
- [ ] All tests pass at 100% coverage

---

### BUG-RV-03: Previously-voted motions remain interactive in revote flow instead of being locked

**Status:** ✅ Implemented

**Fix:** Frontend replaces the `isMotionReadOnly` function body: a motion is locked simply when `m.already_voted`. Removes the now-unused `hasUnsubmittedSelected` variable.

**Acceptance Criteria:**

- [ ] In the revote scenario, motions the voter has previously answered display with the "Already voted" badge and disabled vote buttons
- [ ] In the revote scenario, only newly revealed unvoted motions have interactive vote buttons
- [ ] All tests pass at 100% coverage

---

### BUG-RV-04: Per-lot per-motion vote status not available to frontend

**Status:** ✅ Implemented

**Fix:** Backend adds `voted_motion_ids: list[uuid.UUID]` to `LotInfo`. Frontend adds `voted_motion_ids: string[]` to the `LotInfo` TypeScript interface.

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` and `POST /api/auth/session` return `voted_motion_ids` on each `LotInfo` object
- [ ] `voted_motion_ids` contains only motion IDs where `Vote.status == submitted`; draft votes are excluded
- [ ] All tests pass at 100% coverage

---

### BUG-RV-05: No warning when multi-lot voter selects a mix of voted and unvoted lots

**Status:** ✅ Implemented

**Fix:** Frontend adds a `MixedSelectionWarningDialog` component that appears when the voter clicks "Submit ballot" and any two selected lots have different `voted_motion_ids` sets. A motion is locked only when ALL currently-selected lots have voted on it.

**Acceptance Criteria:**

- [ ] When the voter clicks "Submit ballot" and any two selected lots have different `voted_motion_ids` sets, a warning dialog is shown before the existing submit confirmation dialog
- [ ] The warning fires even when both lots are "partial" but with different motion coverage
- [ ] A motion is locked (read-only) only when ALL currently-selected lots have voted on it
- [ ] Fresh lots always see blank motion cards even if another selected lot's `submitted_choice` is non-null
- [ ] All tests pass at 100% coverage

---

### BUG-LS-01: Submitted lots remain selectable after voting and back navigation

**Status:** ✅ Implemented

**Fix:** In `submitMutation.onSuccess`: update `allLots` state and `meeting_lots_info_<meetingId>` in sessionStorage to mark submitted lots as `already_submitted: true` and update `voted_motion_ids`.

**Acceptance Criteria:**

- [ ] After submitting for one or more lots, navigating back to the voting page shows submitted lots with "Already submitted" badge and disabled checkboxes
- [ ] The Submit ballot button is absent when all lots have been submitted
- [ ] All tests pass at 100% coverage

---

### US-FIX-NM01: Previously-submitted lots unlock when admin reveals new motions

**Status:** ✅ Implemented

**Fix:** `VotingPage` derives lot-submitted status dynamically: a lot is considered submitted when every currently-visible motion ID appears in `lot.voted_motion_ids`. `submitMutation.onSuccess` updates `voted_motion_ids` for submitted lots in both React state and sessionStorage. `prevMotionCountRef` and its associated `useEffect` are removed (previously caused the fix to fail on re-mounts after batch 1).

**Acceptance Criteria:**

- [ ] After voting all visible motions, if the admin makes an additional motion visible, refreshing or returning to the VotingPage shows those lots as unlocked
- [ ] The new motion is shown as interactive (not read-only) on the VotingPage
- [ ] This correct unlock-on-return behaviour holds for any number of batch cycles (addresses BUG-NM-01-B)
- [ ] All tests pass at 100% coverage

---

### US-FIX-PF01: No pre-fill for unlocked motions on revote

**Status:** ✅ Implemented

**Fix:** In the `choices` seeding effect, only carry forward `submitted_choice` when `isMotionReadOnly(motion)` is `true`. Unlocked motions must start with `null`. `isMotionReadOnly` is wrapped in `useCallback` and included in the seeding effect's dependency array.

**Acceptance Criteria:**

- [ ] A motion that is NOT locked always starts with no pre-filled choice — all vote buttons render as `aria-pressed="false"` on page load
- [ ] A motion that IS locked may show the prior choice (`submitted_choice`) as a display aid
- [ ] All tests pass at 100% coverage

---

### US-UI08: Show motion numbers in the submit dialog

**Status:** ✅ Implemented

**Acceptance Criteria:**

- [ ] When the submit dialog shows the "Unanswered motions" list, each item displays "Motion N — [title]"
- [ ] The `SubmitDialog` component accepts `unansweredMotions: { order_index: number; title: string }[]` instead of `unansweredTitles: string[]`
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-UI-FIX-06: Building selector on voter home page is a search combobox

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As a voter, I want a search-enabled combobox for selecting my building on the home page so I can quickly find my building by typing part of its name, consistent with the admin portal's building search experience.

**Acceptance Criteria:**

- [ ] The building selector on the voter home page (`BuildingSelectPage`) is a text input with `role="combobox"` (not a `<select>` dropdown)
- [ ] Typing in the input filters the building list by name (case-insensitive substring match on the pre-fetched list)
- [ ] A dropdown listbox appears below the input showing matching buildings (maximum 5–10 visible at a time with scroll)
- [ ] Selecting a building from the dropdown sets the building ID and triggers the meeting list query
- [ ] A "clear" or "All buildings" option is available to deselect the current building
- [ ] Keyboard navigation: Arrow Down/Up moves between options; Enter selects; Escape closes without selecting
- [ ] Error message (if any) appears below the input in the `.field__error` style
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-07: Voter confirmation page shows per-option colour-coded choices for multi-choice motions

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As a voter reviewing my submitted ballot, I want each option on a multi-choice motion to appear on its own line with colour coding consistent with the voting page (For=green, Against=red, Abstained=grey) so I can easily read my choices.

**Acceptance Criteria:**

- [ ] On the voter confirmation page, multi-choice motions with `option_choices` render each option as a separate line
- [ ] Each option line shows the option text and the voter's choice, colour-coded: For → green, Against → red, Abstained → grey
- [ ] The colour tokens used are `var(--green)`, `var(--red)`, and `var(--text-muted)` from the design system
- [ ] The `not_eligible` case for an entire motion continues to render as a single muted line
- [ ] The `abstained` case (zero options selected) continues to render as a single "Abstained" line
- [ ] Multi-lot and single-lot confirmation views are both updated
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-08: "View Submission" button visible as soon as any lot is submitted

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As a voter with multiple lots who has already submitted for some lots, I want a "View Submission" button visible on the voting page so I can review my submitted votes at any time without finishing all remaining lots first.

**Acceptance Criteria:**

- [ ] On the voting page, the "View Submission" button appears as soon as at least one lot has a submitted ballot (not only after all lots are done)
- [ ] The button appears below the "Submit ballot" button when there are still unvoted motions
- [ ] Clicking "View Submission" navigates to the confirmation page
- [ ] For single-lot voters who have not yet submitted, the button remains hidden
- [ ] The existing "all voted" message with its "View Submission" button (shown when `unvotedCount === 0` and `!showSidebar`) is unchanged
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-SO-01: Voter sign-out from voting page

**Status:** ✅ Implemented — branch: `fix/sign-out`, committed 2026-04-12

**Description:** As a voter, I want a "Sign out" button on the voting page that ends my session and returns me to the home page, so I can hand off a shared device without leaving my session active.

**Acceptance Criteria:**

- [ ] The "← Back" button on `VotingPage` is renamed to "Sign out"
- [ ] Clicking "Sign out" calls `POST /api/auth/logout` before navigating
- [ ] `POST /api/auth/logout` deletes the `SessionRecord` row from the database (invalidates the server-side session) in addition to clearing the cookie
- [ ] After logout the browser's `agm_session` cookie is cleared (delete-cookie response header)
- [ ] All `sessionStorage` keys scoped to the meeting (`meeting_lots_<id>`, `meeting_lots_info_<id>`, `meeting_lot_info_<id>`, `meeting_building_name_<id>`, `meeting_title_<id>`, `meeting_mc_selections_<id>`) are removed
- [ ] The React Query cache is cleared so stale voter state cannot leak to the next user
- [ ] The voter is navigated to the home page (`/`) — not to the auth page — after sign-out
- [ ] If the `POST /api/auth/logout` call fails (network error or non-2xx), the client still clears local state and navigates to `/` — sign-out must never be blocked by a failed server call
- [ ] Sign-out is idempotent: calling it when no session exists still returns 200 and navigates cleanly
- [ ] The "Sign out" button uses the `.btn--ghost` class, consistent with the existing back-button styling (design system: tertiary nav actions)
- [ ] The "← Back" button in the error state (meeting-not-found) retains its existing label and behaviour (it navigates to `/vote/<id>/auth`; it does not trigger sign-out)
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

## Functional Requirements

- FR-4: Authentication is a two-step email OTP flow. The voter submits their email to `POST /api/auth/request-otp`; a cryptographically random 6-digit code is stored in `auth_otps` with a 5-minute expiry and emailed to the voter. The voter then calls `POST /api/auth/verify` with the code; on success the system identifies all lot owner records in that building sharing the same email (direct ownership and proxy nominations), and a server-side session is created. A 60-second rate limit applies to `request-otp` per `(email, meeting_id)` pair.
- FR-5: A **ballot** represents one formal submission per lot per meeting. Ballots are immutable once submitted. A second submission attempt for the same lot and meeting is rejected with a 409 error.
- FR-5a: When a lot owner submits their ballot, any binary motion without an explicit selection is automatically recorded as `abstained`.
- FR-5b: Vote tallies use four categories per motion: **For**, **Against**, **Abstained**, and **Absent** (voter never submitted; draft discarded on close). In-arrear lots on General Motions are recorded as **Not Eligible**.
- FR-13: Motion selections are held entirely in client-side React state — no draft auto-save to the backend occurs. Vote choices are passed **inline** in the `POST /api/general-meeting/{id}/submit` request body as a `votes` list. Any draft Vote rows for the submitting lots are deleted before the submitted Vote rows are inserted.
- FR-V7: For in-arrear lots, the backend records `not_eligible` on General Motions at submission time, regardless of what choice (if any) the voter made on the frontend.
- FR-V8: `GeneralMeetingLotWeight` gains a `financial_position_snapshot` column that captures each lot's financial position at meeting creation time. This snapshot — not the live `lot_owners.financial_position` — governs in-arrear eligibility.

---

## Non-Goals

- No per-lot different vote choices within the same submission — all lots selected in one submission receive the same votes
- No public-facing display of financial position to other voters
- No automatic promotion from 'in_arrear' to 'normal' based on payment data
- No proxy approval workflow — nominations take effect immediately
