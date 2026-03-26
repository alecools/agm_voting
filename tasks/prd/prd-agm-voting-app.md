# PRD: AGM Voting App

## Introduction

A web application for body corporates to run voting during Annual General Meetings (AGMs). The host creates an AGM with a list of motions and a scheduled voting close time. At AGM creation, unit entitlement weights are snapshotted for every lot in the building; any subsequent changes to lot owner data do not affect that AGM's tallies. Lot owners authenticate with their lot number and email, cast yes/no/abstain votes on each motion, and submit their ballot (votes are final once submitted). Individual motion selections are held in client-side state until the lot owner submits their ballot; unsubmitted voters are recorded as absent when the AGM closes. Motions left unanswered on a submitted ballot are recorded as abstained. When the manager closes voting, the system emails a summary report to the manager's email address stored against the building.

## Goals

- Allow a meeting host to create an AGM with motions, a meeting date/time, and a scheduled voting close time via a dedicated host admin portal; snapshot lot entitlement weights at creation
- Allow lot owners to self-authenticate using lot number + email (no account creation required); one ballot per unique email per building per AGM
- Allow lot owners to vote yes/no/abstain on each motion; votes are held in client-side state and are final once submitted
- Show lot owners a countdown timer (anchored to server time) to scheduled close with a 5-minute warning; allow lot owners to review past AGM submissions
- Allow the manager to close voting and trigger an automated result report sent to the building's manager email, with up to 30 retries and OTEL-compliant logging
- Support lot owner data ingestion via CSV upload, manual UI entry, and sync from PropertyIQ
- Support building creation and updates via CSV upload; building names are globally unique
- Weight each ballot by the snapshotted sum of unit entitlements for all lots owned by the voter's email, taken at AGM creation time

---

## User Stories

### US-011: Host admin portal

**Description:** As a meeting host, I want a dedicated admin portal so I can manage buildings, lot owners, and AGMs separate from the lot owner–facing voting flow.

**Acceptance Criteria:**

- [ ] A separate web route (e.g. `/admin`) serves the host portal; it is distinct from the lot owner flow
- [ ] The portal provides navigation to: Buildings, AGMs, and Lot Owners sections
- [ ] Admin portal login is required (see US-020)
- [ ] Typecheck/lint passes

---

### US-BLD-DELETE: Delete an archived building

**Description:** As a building manager, I want to permanently delete a building that has been archived so I can remove test or incorrectly created buildings from the system.

**Acceptance Criteria:**
- [x] `DELETE /api/admin/buildings/:id` endpoint added
- [x] Returns 204 on success; the building and all cascade data (lot owners, general meeting lot weights, ballot submissions, votes, session records, motions, general meetings) are deleted
- [x] Returns 404 if the building does not exist
- [x] Returns 409 if the building is not archived (only archived buildings can be deleted)
- [x] A "Delete Building" button is visible on the building detail/edit page only when the building is archived
- [x] Clicking the button shows a browser confirmation dialog before proceeding
- [x] On success, admin is navigated to the buildings list
- [x] Button shows "Deleting…" while the request is in flight
- [x] Typecheck/lint passes
- [x] All tests pass at 100% coverage

---

### US-019: Archive buildings and associated lot owners

**Description:** As a meeting host, I want to archive a building so it no longer appears in the voter portal, and have its lot owners archived too unless they belong to another active building.

**Acceptance Criteria:**

- [ ] Admin can archive a building via a button on the building detail page; a confirmation dialog is shown before archiving
- [ ] Archiving sets `is_archived = true` on the building
- [ ] Archiving also sets `is_archived = true` on every lot owner in the building, unless that lot owner's email also appears as a lot owner in another non-archived building
- [ ] Attempting to archive an already-archived building returns 409
- [ ] Archived buildings are excluded from the voter-facing building dropdown (`GET /api/buildings`)
- [ ] Archived buildings are excluded from the voter-facing AGM list (`GET /api/buildings/{id}/agms` returns 404 for archived buildings)
- [ ] Archived buildings still appear in the admin portal buildings list, with a visual "Archived" badge; they can be clicked to view details
- [ ] Admin buildings list includes a toggle to show/hide archived buildings (default: show active only)
- [ ] Typecheck/lint passes

---

### US-020: Admin portal authentication

**Description:** As a meeting host, I want the admin portal to require a username and password login so unauthorised users cannot access or modify AGM data.

**Acceptance Criteria:**

- [ ] All `/api/admin/*` endpoints (except login/logout/me) return 401 if the request is not authenticated
- [ ] `POST /api/admin/auth/login` accepts `username` and `password`; on success sets a signed session cookie and returns `{"ok": true}`; on failure returns 401
- [ ] `POST /api/admin/auth/logout` clears the session and returns `{"ok": true}`
- [ ] `GET /api/admin/auth/me` returns `{"authenticated": true}` if logged in, else 401
- [ ] Credentials are configured via `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables with defaults `admin` / `admin`
- [ ] Admin portal frontend redirects unauthenticated users to `/admin/login`
- [ ] Login page shows username and password fields; on success navigates to `/admin`
- [ ] Admin layout sidebar shows a "Logout" button that calls logout endpoint and redirects to `/admin/login`
- [ ] Typecheck/lint passes

---

### US-012: Create and manage buildings via form or CSV/Excel upload

**Description:** As a meeting host, I want to create or update building records via a manual form or file upload so I don't have to maintain buildings manually.

**Acceptance Criteria:**

- [ ] Host can create a single building by entering name and manager email via a "+ New Building" form in the Buildings admin page; form is toggled inline and dismissed on success or cancel
- [ ] Host can upload a CSV or Excel (.xlsx / .xls) file to bulk-create/update buildings; the file input accepts both formats
- [ ] Both file formats use the same column names: `building_name` and `manager_email` (one row per building)
- [ ] `building_name` must be globally unique (case-insensitive); attempting to create a duplicate is rejected with a clear error (409)
- [ ] File upload creates a new building if `building_name` does not already exist; updates `manager_email` if it does
- [ ] Additional columns are ignored
- [ ] System validates the file format and reports errors (missing columns, blank values) before importing
- [ ] Successful upload shows count of buildings created and updated
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-BLD-01: Edit building name and manager email

**Description:** As a meeting host, I want to edit a building's name and manager email from the Building Detail page so I can keep building information up to date.

**Acceptance Criteria:**

- [ ] Admin can edit `name` and/or `manager_email` for an existing building from the BuildingDetailPage via an "Edit Building" button in the page header
- [ ] Clicking "Edit Building" opens a modal pre-filled with the current name and manager email
- [ ] "Save Changes" submits a `PATCH /api/admin/buildings/{id}` request; on success the modal closes and the page header updates with the new values
- [ ] At least one field must differ from the current value to enable submission; if neither field changed, an error is shown inline: "No changes detected"
- [ ] `PATCH /api/admin/buildings/{id}` accepts body `{ "name"?: string, "manager_email"?: string }` — at least one field must be provided (422 if both are absent/null)
- [ ] Empty string for `name` or `manager_email` returns 422
- [ ] `PATCH` returns the updated `BuildingOut` on success
- [ ] If the building does not exist, 404 is returned
- [ ] Server-side errors are shown inline in the modal
- [ ] "Cancel" closes the modal without saving
- [ ] Typecheck/lint passes

---

### US-BLD-02: Filter voter building dropdown to buildings with open meetings

**Description:** As a lot owner, I want the building dropdown on the voter home page to show only buildings that have an active (open) voting session, so I am not presented with buildings where there is nothing to vote on.

**Acceptance Criteria:**

- [ ] `GET /api/buildings` returns only buildings where at least one associated General Meeting has an **effective status** of `"open"` — i.e. stored `status != 'closed'`, `meeting_at` is in the past or present, and `voting_closes_at` is in the future
- [ ] A building with no meetings is excluded from the response
- [ ] A building with only closed meetings (manually closed or with `voting_closes_at` in the past) is excluded from the response
- [ ] A building with only pending meetings (`meeting_at` in the future) is excluded from the response
- [ ] A building with at least one open meeting and one or more closed meetings is included in the response
- [ ] Archived buildings (`is_archived = true`) remain excluded regardless of meeting status (existing rule unchanged)
- [ ] No change to `GET /api/buildings/{building_id}/general-meetings` — this endpoint continues to return all meetings for a building (used after a voter has selected a building)
- [ ] No database schema changes required
- [ ] Typecheck/lint passes
- [ ] All tests pass at 100% coverage

---

### US-001: Create a new AGM

**Description:** As a meeting host, I want to create a new AGM so that lot owners can vote on motions for an upcoming meeting.

**Acceptance Criteria:**

- [ ] Host can create an AGM (from the admin portal) by providing: building selection, meeting title, meeting date/time, scheduled voting close date/time, and one or more motions (each with a title, optional description, and optional motion number)
- [ ] Scheduled voting close date/time must be after the meeting date/time; validation error shown if not
- [ ] Each motion is stored with a display order (1-based integer) and an optional motion number string
- [ ] AGM is created in "open" status immediately — there is no draft state
- [ ] On creation, the system snapshots the unit entitlement of every lot in the building into an immutable `agm_lot_weights` record (see FR-14); this snapshot is used for all tally calculations for this AGM regardless of future lot owner data changes
- [ ] AGM has a shareable URL that the host can copy and send to lot owners
- [ ] Once created, the AGM and its motions are immutable — no edits are permitted regardless of status (see FR-11)
- [ ] Only one open AGM may exist per building at a time; attempting to create a second is rejected with a clear error
- [ ] Typecheck/lint passes

---

### US-MN-01: Custom motion number

**Description:** As a meeting host, I want to assign a custom display label (motion number) to each motion so that the voting page and reports show the official motion numbering from the meeting agenda (e.g. "5", "5a", "5b", "Special Resolution 1") rather than a sequential counter.

**Acceptance Criteria:**

- [ ] The AGM creation form includes an optional "Motion number" text field for each motion; the field accepts any non-empty string up to 100 characters (e.g. "5", "5a", "Special Resolution 1")
- [ ] Leaving the motion number field blank is valid; if omitted at creation or add-motion time, `motion_number` is auto-assigned as `str(display_order)` (e.g. "1", "2", "3") so every motion always has a non-null number
- [ ] Whitespace-only input (e.g. spaces only) is treated as blank and stored as `NULL`; the UI placeholder communicates "Auto (e.g. 3)"
- [ ] On the voter-facing voting page, each motion card label is always rendered as `"MOTION {motion_number}"` — the "MOTION" prefix is always present; `motion_number` is always set (never null) for motions created after the auto-assign feature landed
- [ ] On the public meeting summary page, each motion is listed with its `motion_number` as the label if set; otherwise `display_order` is used as fallback
- [ ] In the admin AGM detail page motion table, a "Motion #" column shows the custom motion number (blank if not set)
- [ ] The AGM results report (admin) uses `motion_number` as the motion label if set; otherwise the positional label
- [ ] Motion numbers are unique per AGM — adding a motion with a duplicate non-null `motion_number` returns 409; the partial unique index (`WHERE motion_number IS NOT NULL`) enforces this at the database level
- [ ] Motion number has no effect on display order; changing a motion's number does not change its position in the list
- [ ] `motion_number` is included in all motion-related API responses: `GET /api/general-meeting/{id}/motions`, `GET /api/general-meeting/{id}/my-ballot`, `GET /api/general-meeting/{id}/summary`, `GET /api/admin/general-meetings/{id}`
- [ ] When editing a hidden motion via the Edit Motion modal on the admin General Meeting detail page, the admin can change or clear the motion number; the new value is persisted and reflected in the motion table after saving; `PATCH /api/admin/motions/{id}` accepts and persists `motion_number`
- [ ] `motion_number` is stable across reorders — `PUT /api/admin/general-meetings/{id}/motions/reorder` only updates `display_order`; it never modifies `motion_number`
- [ ] On the voter-facing voting page, motion position is determined by `display_order`, not array index — a voter who sees motions with `display_order` 2 and 3 (motion 1 hidden) sees headings "MOTION 2" and "MOTION 3", not "MOTION 1" and "MOTION 2"
- [ ] The confirmation/SubmitDialog shows the same "MOTION {motion_number}" label alongside each motion title in the unanswered-motions list
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MN-02: Admin motion reordering

**Description:** As a meeting host, I want to change the display order of motions so that voters see them in the intended agenda sequence, with drag-and-drop as the primary interaction and keyboard-accessible move buttons as fallback.

**Acceptance Criteria:**

- [ ] On the admin AGM detail page (open or pending meetings only), each row in the motion table has a drag handle that allows the admin to drag and drop it to a new position
- [ ] On the same page, each motion row has two order-control buttons in the Actions column: "Move to top" (⤒) and "Move to bottom" (⤓); "Move to top" is disabled for the first motion; "Move to bottom" is disabled for the last motion
- [ ] Reordering takes effect immediately in the UI (optimistic update); the new order is persisted via `PUT /api/admin/general-meetings/{id}/motions/reorder` with the complete ordered list of motion IDs
- [ ] If the reorder API call fails, the UI reverts to the pre-drag order and shows an error message
- [ ] Reordering is not available when the meeting is closed — drag handles and move buttons are absent on the closed meeting detail page
- [ ] After a reorder, the voter-facing voting page shows motions in the new order (sorted by `display_order`)
- [ ] After a reorder, the public summary page shows motions in the new order
- [ ] Changing display order does NOT change any motion's `motion_number` — the labels are preserved exactly as set
- [ ] A meeting with a single motion has no drag handle and no move buttons (nothing to reorder)
- [ ] `PUT /api/admin/general-meetings/{id}/motions/reorder` returns 409 if the meeting is closed, 422 if the submitted list is incomplete or has duplicate positions, 404 if the meeting does not exist
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MN-03: Unified motion management table

**Description:** As a meeting host, I want reorder controls (drag-and-drop + move buttons) and visibility toggles in a single table so I can manage motion ordering and visibility in one place, rather than switching between two separate panels.

**Acceptance Criteria:**

- [ ] The admin AGM detail page shows a single "Motions" table that combines: drag handle, motion number, title/description, type badge, visibility toggle, and action buttons (Edit/Delete, plus reorder buttons ⤒ ⤓)
- [ ] The separate "Motion Reorder" panel and "Motion Visibility" heading are removed — all motion management happens in one table
- [ ] Drag handles and move-to-top/bottom buttons appear in the Actions column when the meeting is open or pending
- [ ] Drag handles and move buttons are absent when the meeting is closed
- [ ] Visibility toggles behave identically to the previous standalone table: disabled when closed, disabled when motion has received votes, inline error on failure
- [ ] Hidden motions appear with muted styling on data cells (#, title, type) but full opacity on the visibility toggle and action buttons
- [ ] Edit and Delete buttons remain disabled when a motion is visible (must hide first), same as before
- [ ] "Add Motion", "Show All", and "Hide All" buttons appear above the table (not closed meetings)
- [ ] All existing reorder and visibility behaviour is preserved — this is a UI consolidation, not a behaviour change
- [ ] Deleting a motion shows a confirmation modal dialog (not a browser `confirm()` popup); the modal has "Delete" and "Cancel" buttons and shows the motion title
- [ ] Visibility toggle applies an optimistic UI update immediately on click — the toggle state changes before the API response arrives; on error the toggle reverts
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MN-04: Admin login page uses tenant branding logo

**Description:** As a meeting host, I want the admin login page to display the configured tenant logo rather than a hardcoded static image, so the login screen is consistent with the rest of the branded app.

**Acceptance Criteria:**

- [ ] The admin login page (`/admin/login`) reads the logo URL from `useBranding()` / `BrandingContext` (the same source used by the admin sidebar and voter shell)
- [ ] When `logo_url` is a non-empty string, the login card displays `<img src={logo_url}>` — the configured tenant logo
- [ ] When `logo_url` is empty string or not set, no broken image is displayed; the login card renders without an image
- [ ] The hardcoded `/logo.png` and `/logo.webp` references are removed from the login page
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-002: Building selection, AGM list, and past submission review

**Description:** As a lot owner, I want to select my building, see all AGMs for that building, enter the active voting session, and review my past submissions.

**Acceptance Criteria:**

- [ ] Entry page shows a building dropdown listing all buildings in the system
- [ ] On selecting a building, a list of all AGMs for that building is shown, ordered with the most recent first; if the building has no AGMs, a "No meetings scheduled for this building" message is shown
- [ ] Each AGM in the list shows: meeting title, meeting date/time, scheduled voting close date/time, and current status (Open / Closed); all times are displayed in the user's local browser timezone
- [ ] An open AGM shows an "Enter Voting" button that takes the lot owner to authentication (US-003)
- [ ] A closed AGM shows a "View My Submission" button that takes the lot owner to authentication (US-003); after successful authentication the confirmation screen (US-009) is shown if they submitted, or an "You did not submit a ballot for this meeting" message if they were absent
- [ ] Proceeding without selecting a building shows a validation error
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-003: Lot owner authentication

**Description:** As a lot owner, I want to verify my identity via a one-time email code so the system can confirm I am eligible to vote without requiring a password or lot number.

> **Supersedes the original lot-number + email flow.** Authentication is now a two-step OTP flow (see US-OTP-01 through US-OTP-05 below). The lot number field is removed from the auth form entirely.

**Acceptance Criteria:**

- [ ] Lot owner enters only their email address on the auth form (no lot number field)
- [ ] Clicking "Send Verification Code" triggers `POST /api/auth/request-otp`; a 6-digit code is emailed to the address
- [ ] The form transitions to a code-entry step showing "We sent a 6-digit code to {email}"
- [ ] Lot owner enters the 6-digit code and clicks "Verify"; the frontend calls `POST /api/auth/verify` with `{email, code, general_meeting_id}`
- [ ] On valid code: system identifies all lots in that building registered to the same email (direct or proxy); a session is created scoped to that email + building + AGM
- [ ] If the lot owner has already submitted a ballot for this AGM, they are taken directly to the confirmation screen (US-009)
- [ ] If the lot owner has not yet submitted, they are taken to the voting page with a fresh ballot (no server-side draft restoration)
- [ ] On invalid or expired code: a clear inline error is shown ("Invalid or expired code. Please try again."); the code input is cleared
- [ ] No account creation or password required
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-OTP-01: Email OTP request

**Description:** As a lot owner, I want to enter my email and receive a one-time verification code so I can begin the authentication process without a password.

**Acceptance Criteria:**

- [ ] The auth form shows a single "Email address" field and a "Send Verification Code" button on the first step
- [ ] Submitting with an empty email shows an inline validation error; the API is not called
- [ ] `POST /api/auth/request-otp` accepts `{email, general_meeting_id, skip_email?}` and:
  - [ ] Returns 200 `{"sent": true}` if the meeting exists, regardless of whether the email matches any lot owner (user-enumeration protection)
  - [ ] Generates a cryptographically random 6-digit code (`secrets.randbelow(1_000_000)` zero-padded) and stores it in `auth_otps` with `expires_at = now() + 5 minutes`
  - [ ] Sends an OTP email to the address with subject `"Your AGM Voting Code — {meeting_title}"` containing the code and a note that it expires in 5 minutes — unless `skip_email: true` is passed, in which case the OTP is stored but no email is sent (SMTP call is skipped)
  - [ ] `skip_email` defaults to `false`; the UI never passes this parameter; it is only used by E2E test helpers to avoid sending real emails during automated runs
  - [ ] If SMTP fails (and `skip_email` is not set), the error is logged but the endpoint still returns 200 (OTP is already in DB; caller can retry)
  - [ ] Deletes any previous OTP rows for the same `(email, meeting_id)` pair before inserting the new one (lazy cleanup)
  - [ ] Returns 404 if `general_meeting_id` does not exist
  - [ ] Returns 422 if the email field is empty or missing
- [ ] The "Send Verification Code" button is disabled and shows "Sending…" while the request is in flight
- [ ] Typecheck/lint passes

---

### US-OTP-02: OTP verification (success)

**Description:** As a lot owner, I want to enter my verification code and be authenticated so I can proceed to vote.

**Acceptance Criteria:**

- [ ] After `request-otp` succeeds, the form shows a "Verification code" input (`type="text"`, `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength=6`) and a "Verify" button
- [ ] Submitting with an empty code shows an inline validation error; the API is not called
- [ ] `POST /api/auth/verify` accepts `{email, code, general_meeting_id}` and:
  - [ ] Looks up the most recent unused, unexpired `AuthOtp` row for `(email, meeting_id)`
  - [ ] If the code matches: marks the OTP as `used = TRUE`, then proceeds with lot lookup, session creation, and returns the existing `AuthVerifyResponse` (unchanged shape)
  - [ ] Sets a `meeting_session` cookie on success (unchanged behaviour)
- [ ] The "Verify" button is disabled and shows "Verifying…" while the request is in flight
- [ ] On success, the page navigates as per existing logic (voting page, confirmation page, or pending message)
- [ ] Typecheck/lint passes

---

### US-OTP-03: OTP expiry (5-minute window)

**Description:** As a lot owner, I want the system to reject codes older than 5 minutes so that stale codes cannot be used to authenticate.

**Acceptance Criteria:**

- [ ] OTP codes expire exactly 5 minutes after generation (`expires_at = created_at + 5 minutes`, stored in UTC)
- [ ] `POST /api/auth/verify` called with an expired code returns 401 `{"detail": "Invalid or expired verification code"}`
- [ ] The frontend shows the error message "Invalid or expired code. Please try again." and clears the code input
- [ ] Expiry is checked server-side against the database `expires_at` column using `now()` (UTC); client clock is not trusted
- [ ] Typecheck/lint passes

---

### US-OTP-04: Invalid OTP error handling

**Description:** As a lot owner, I want clear feedback when I enter the wrong code so I know to try again or request a new one.

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` with a code that does not match the stored value returns 401 `{"detail": "Invalid or expired verification code"}` (same message as expiry — no oracle)
- [ ] `POST /api/auth/verify` with a code that has already been used (`used = TRUE`) returns 401 with the same message
- [ ] `POST /api/auth/verify` with no OTP row at all for the `(email, meeting_id)` pair returns 401 with the same message
- [ ] The frontend shows the inline error and clears the code input field so the user cannot accidentally re-submit the same wrong code
- [ ] Typecheck/lint passes

---

### US-OTP-05: Resend code

**Description:** As a lot owner, I want to request a new code if I did not receive the first one or it has expired, so I am not locked out.

**Acceptance Criteria:**

- [ ] A "Resend code" button/link is shown below the code input on step 2 of the auth form
- [ ] Clicking "Resend code" calls `POST /api/auth/request-otp` again with the same email and meeting ID
- [ ] A new code is generated, the previous OTP row(s) for `(email, meeting_id)` are deleted, and a new email is sent
- [ ] The backend enforces a 60-second minimum interval between OTP requests for the same `(email, meeting_id)` pair; requests within that window return 429 `{"detail": "Please wait before requesting another code"}`
- [ ] The code input is cleared when a resend is triggered so the user starts fresh
- [ ] The previously issued code is no longer valid after a resend (it was deleted)
- [ ] Typecheck/lint passes

---

### US-PS-01: Persistent voter session (skip OTP on return visit)

**Description:** As a lot owner, I want my authenticated session to be remembered across browser tab closures so that I do not have to re-enter my email and OTP code every time I open the voting app within the same day.

**Acceptance Criteria:**

- [ ] After a successful OTP verification, the session token is stored in `localStorage` under the key `agm_session_<meetingId>`
- [ ] When a voter navigates to `/vote/<meetingId>/auth` and a valid token exists in `localStorage`, the app calls `POST /api/auth/session` with the stored token instead of showing the OTP form
- [ ] While the session restore request is in flight, a "Resuming your session…" loading indicator is shown; the OTP form does not flash
- [ ] On a successful session restore, the voter is taken directly to the voting page (or confirmation page if all lots are already submitted) — no OTP entry required
- [ ] `POST /api/auth/session` accepts `{ session_token: string, general_meeting_id: UUID }` and returns the same `AuthVerifyResponse` shape as `POST /api/auth/verify`, including the `session_token` field
- [ ] `POST /api/auth/session` returns 401 if the token is not found, expired (> 24 hours old), or the meeting is closed
- [ ] On a 401 response from `POST /api/auth/session`, the stale token is removed from `localStorage` and the normal OTP auth form is shown
- [ ] Sessions expire after 24 hours — re-authentication via OTP is required after that window
- [ ] When a meeting is closed, any stored token for that meeting becomes immediately invalid; the next restore attempt returns 401 and the voter is taken through OTP (which then routes to the confirmation page via `agm_status: "closed"`)
- [ ] `POST /api/auth/verify` response now includes a `session_token` field (the raw token string) so the frontend can store it; existing response fields are unchanged
- [ ] No new environment variables or secrets are required — the session token uses `secrets.token_urlsafe(32)` stored in the existing `session_records` table
- [ ] Verify in browser using dev-browser skill
- [ ] Typecheck/lint passes
- [ ] All tests pass at 100% coverage

---

### US-004: Vote on motions

**Description:** As a lot owner, I want to vote yes, no, or abstain on each motion and submit my ballot so I can participate in the AGM.

**Acceptance Criteria:**

- [ ] The voting page header shows: building name, AGM title, meeting date/time, and scheduled voting close date/time (all times in the user's local browser timezone)
- [ ] All motions for the AGM are listed in order with title and description
- [ ] Each motion has three clearly labelled options: **Yes**, **No**, **Abstain**; any option can be deselected back to unanswered at any time before submission
- [ ] A progress bar shows how many motions have been answered out of the total (e.g. "4 / 7 motions answered")
- [ ] Every time a lot owner selects or changes an option on a motion, that selection is held in client-side React state; no auto-save to the backend occurs
- [ ] A countdown timer to the scheduled voting close time is shown persistently on the page; the timer is calculated from server time fetched on page load to avoid client clock skew (see FR-15)
- [ ] At 5 minutes before the scheduled close time, a prominent warning banner is shown: "Voting closes in 5 minutes — please submit your ballot"
- [ ] If any of the voter's selected lots are in arrear, an informational amber banner is shown above the motions list:
  - [ ] If all selected lots are in arrear: "All your selected lots are in arrear. You may only vote on Special Motions — General Motion votes will be recorded as not eligible."
  - [ ] If some (but not all) selected lots are in arrear: "Some of your selected lots are in arrear. Your votes on General Motions will not count for in-arrear lots — they will be recorded as not eligible. Votes for all other lots will be recorded normally."
  - [ ] The banner is purely informational — vote buttons remain interactive for all motion types; per-lot eligibility is enforced by the backend at submission time
  - [ ] The banner updates immediately when the voter toggles which lots are selected (multi-lot voters)
- [ ] The page polls the AGM status every 10 s; if the AGM is found to be closed before the lot owner submits, inputs are immediately disabled and a "Voting has closed" message is shown
- [ ] A "Submit Votes" button is shown at the bottom; drafts are NOT counted in tallies until Submit is clicked
- [ ] On clicking Submit:
  - [ ] Any motions with no selection are visually highlighted (e.g. outlined in amber) and a count is shown: "X motion(s) have no answer selected"
  - [ ] If there are unanswered motions, a review dialog lists them and asks the lot owner to confirm: "The following motions have no answer and will be recorded as Abstained. Confirm submission?"
  - [ ] If all motions are answered, a standard confirmation dialog is shown: "Are you sure? Votes cannot be changed after submission."
- [ ] Once confirmed and submitted, all inputs are locked and the confirmation screen is shown (see US-009)
- [ ] Votes are immutable after submission — no changes are permitted under any circumstances
- [ ] If a second submission attempt is made (e.g. duplicate tab), it is rejected with a clear error: "A ballot has already been submitted for this voter"
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-009: Vote confirmation screen

**Description:** As a lot owner, I want to see a summary of my submitted votes so I have a record of how I voted.

**Acceptance Criteria:**

- [ ] Immediately after submitting, a read-only confirmation screen is shown
- [ ] Screen shows: building name, AGM title, and the lot owner's email
- [ ] Screen lists each motion title alongside the owner's recorded vote: Yes, No, or Abstained
- [ ] Screen is shown again if the lot owner re-authenticates (on any device/browser) after submitting — for both open and closed AGMs
- [ ] If the lot owner authenticates against a closed AGM (regardless of whether they submitted), they are taken to the confirmation screen; if they did not submit, "You did not submit a ballot for this meeting" is shown
- [ ] A "Back to Home" button on the confirmation screen returns the lot owner to the building selection page
- [ ] No ability to change votes on this screen
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-005: Import lot owner data via CSV or Excel

**Description:** As a meeting host, I want to upload a CSV or Excel file of lot owners so the system can authenticate them during the AGM.

**Acceptance Criteria:**

- [ ] Host can upload a CSV or Excel (.xlsx / .xls) file; the file input accepts both formats
- [ ] CSV format accepts canonical headers (`lot_number`, `email`, `unit_entitlement`) **or** SBT aliases (`Lot#` → lot_number, `UOE2` → unit_entitlement, `Email` → email); both naming conventions work interchangeably
- [ ] Excel format (matching the `Owners_SBT.xlsx` template in `examples/`) uses headers: `Lot#` (lot number), `UOE2` (unit entitlement), `Email` (email address); other columns are ignored
- [ ] System validates the file format and reports errors (missing required columns, duplicate lot numbers, blank required fields) before importing
- [ ] Successful import shows count of records imported
- [ ] Import uses upsert semantics: existing lot owners matched by `lot_number` are updated in-place (preserving their database ID), new lot numbers are inserted, lot numbers absent from the import file are deleted
- [ ] Upsert preserves `AGMLotWeight` snapshots for any open/closed AGMs — re-importing lot owners must NOT zero out entitlement sums in existing AGM tallies
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-010: Manually add or edit a lot owner via UI

**Description:** As a meeting host, I want to add or edit a lot owner record directly in the UI so I can make quick corrections without re-uploading a CSV.

**Acceptance Criteria:**

- [ ] Host can add a new lot owner by entering: lot number, email address, and unit entitlement
- [ ] Host can edit an existing lot owner's email address or unit entitlement; clicking "Edit" on a row opens the edit form immediately above the lot owner table (not below the page fold)
- [ ] Lot owner records cannot be deleted via the UI (deletion is not supported)
- [ ] Duplicate lot numbers within the same building are rejected with a validation error
- [ ] Changes take effect immediately for authentication purposes but do not affect the weight snapshot of any already-open AGM (see FR-14)
- [ ] The building detail page includes a "Create AGM" button that navigates directly to the AGM creation form
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-006: Sync lot owner data from PropertyIQ

**Description:** As a meeting host, I want to sync lot owner data from PropertyIQ so I don't have to manually export/import CSVs.

**Acceptance Criteria:**

- [ ] Host can trigger a manual sync for a building from the admin portal
- [ ] System fetches lot owner records from the PropertyIQ API for the relevant building
- [ ] Sync result shows count of records added/updated/removed
- [ ] Synced data affects authentication for future logins but does not alter the weight snapshot of any already-open AGM (see FR-14)
- [ ] If sync fails, an error message is shown and existing data is not modified
- [ ] Typecheck/lint passes

---

### US-007: Close AGM and send results report

**Description:** As a meeting manager, I want to close voting and receive a results report so I can record the AGM outcome.

**Acceptance Criteria:**

- [ ] Manager can close an open AGM via a "Close Voting" button in the admin portal
- [ ] On close: AGM status changes to "closed"; all voting inputs are disabled for lot owners; all remaining draft votes are discarded and those voters are recorded as absent
- [ ] System attempts to send one HTML email to the manager email address stored against the building
- [ ] If send fails, the system retries with exponential backoff up to a maximum of 30 attempts; retry schedule and outcomes are logged using OTEL-compliant structured logging
- [ ] If all 30 retries are exhausted, the admin portal displays a clear, persistent error banner: "Results report could not be delivered to [email]. Please retry manually or download the report."
- [ ] A "Retry Send" button resets and restarts the retry sequence for any AGM whose report failed to deliver
- [ ] The report (viewable in-app and sent by email) includes a summary and, for each motion:
  - [ ] Motion title and description
  - [ ] Total Yes: voter count and total weighted unit entitlements (from snapshot)
  - [ ] Total No: voter count and total weighted unit entitlements (from snapshot)
  - [ ] Total Abstained: voter count and total weighted unit entitlements (submitted ballots where the motion was explicitly abstained or left unanswered)
  - [ ] Total Absent: voter count and total weighted unit entitlements (voters who never submitted or whose draft was discarded on close)
  - [ ] Voter lists show **lot numbers and individual entitlements** (not email addresses) to protect privacy; one row per lot
  - [ ] Host can export the full voter breakdown as a CSV file (columns: Motion, Category, Lot Number, Entitlement) via an "Export voter lists (CSV)" button
- [ ] Typecheck/lint passes

---

### US-030: Responsive voting layout and lot selection shortcuts

**Description:** As a lot owner on any device, I want the voting page to make good use of screen space and allow quick lot selection so I can vote efficiently.

**Acceptance Criteria:**

- [ ] The voter content wrapper (`voter-content`) has a max-width of 1280px on desktop (up from 660px), giving more room for the two-column voting layout; a sensible padding (24px) is maintained on wide screens
- [ ] On mobile (≤640px) the voter content wrapper uses 16px left/right padding
- [ ] In the lot sidebar, four shortcut buttons appear above the lot list for multi-lot voters:
  - **Select All** — always shown; selects all pending (not-yet-submitted) lots and clears the no-selection validation error
  - **Deselect All** — always shown; unchecks all lots
  - **Select Proxy Lots** — only shown when the voter has at least one proxy lot; selects only pending proxy lots and clears the no-selection error
  - **Select Owned Lots** — only shown when the voter has at least one proxy lot; selects only pending directly-owned lots and clears the no-selection error
- [ ] Shortcut buttons use `.btn.btn--secondary` style with `font-size: 0.75rem; padding: 3px 10px`
- [ ] Shortcut buttons are arranged in a flex row with `flex-wrap: wrap` and `gap: 6px`
- [ ] Submitted lots are excluded from all shortcut button selections (a submitted lot's checkbox remains disabled and its `already_submitted` state is preserved)
- [ ] On mobile (≤640px) the lot sidebar is collapsible via a toggle button showing `"Your Lots (N selected) ▾/▴"` (or `"Your Lots — all submitted"` when all submitted); default state is **collapsed**
- [ ] The toggle button has `aria-expanded` attribute reflecting current state
- [ ] On desktop (≥641px) the sidebar list is always expanded and the toggle button is hidden
- [ ] Admin pages (`admin-main`) use 16px padding on mobile; the `admin-page-header` stacks vertically on mobile
- [ ] Admin tables are wrapped in a scrollable container (`overflow-x: auto`) so they do not cause horizontal scroll on narrow viewports
- [ ] Typecheck/lint passes

---

## Functional Requirements

- FR-1: A building record contains: name, manager email address, and associated lot owner records. Buildings can be created individually via a form (POST /api/admin/buildings) or bulk-created/updated via CSV or Excel upload (US-012). Building names must be globally unique (case-insensitive).
- FR-2: An AGM belongs to one building, has a status (`open` | `closed`), a title, a meeting date/time (`meeting_at`), and a scheduled voting close date/time (`voting_closes_at`). `voting_closes_at` must be after `meeting_at`. Both fields are stored in UTC and are immutable after creation.
- FR-3: A lot owner record contains: building ID, lot number (string), email address, and unit entitlement (non-negative integer). Lot number must be unique per building. Multiple lots may share the same email address within a building (multi-lot owners). Lot owner records cannot be deleted — only created or edited.
- FR-4: Authentication is a two-step email OTP flow. The voter submits their email to `POST /api/auth/request-otp`; the system generates a cryptographically random 6-digit code, stores it in `auth_otps` with a 5-minute expiry, and emails it to the voter. The voter then calls `POST /api/auth/verify` with the code; on success the system identifies all lot owner records in that building sharing the same email (direct ownership and proxy nominations), and a server-side session is created scoped to that email + building + AGM. Session data is persisted in the database to support vote resumption across session restarts. No JWT, OAuth, or lot number entry required for MVP. The OTP is single-use (`used` flag) and expires after 5 minutes. A 60-second rate limit applies to `request-otp` per `(email, meeting_id)` pair.
- FR-5: A **ballot** represents one formal submission per voter (unique email) per AGM. A ballot contains one vote record per motion with values `yes`, `no`, or `abstained`. Ballots are immutable once submitted — no updates or deletions allowed under any circumstances. A second submission attempt for the same voter and AGM is rejected with a 409 error.
- FR-5a: When a lot owner submits their ballot, any motion without an explicit selection is automatically recorded as `abstained`.
- FR-5b: Vote tallies use four categories per motion: **Yes**, **No**, **Abstained** (submitted with no or explicit abstain selection), and **Absent** (voter never submitted; draft discarded on close). Tallies are the sum of snapshotted ballot weights in each category.
- FR-6: Import for lot owners accepts CSV or Excel (.xlsx / .xls). Both CSV and Excel accept canonical headers (`lot_number`, `email`, `unit_entitlement`) or SBT aliases (`Lot#` → lot_number, `UOE2` → unit_entitlement, `Email` → email); all other columns are ignored. Completely blank rows are skipped. Import performs a full replacement of existing records for the building. Changes do not affect the weight snapshot of any already-open AGM.
- FR-6a: Lot owner records can be created or edited individually via the host admin UI. Deletion is not permitted. Changes do not affect the weight snapshot of any already-open AGM.
- FR-7: PropertyIQ sync is manually triggered (not scheduled) and replaces all lot owner records for the building. Changes do not affect the weight snapshot of any already-open AGM.
- FR-8: The results report is sent as an HTML email via Resend to the manager email stored on the building. On failure, the system retries with exponential backoff up to 30 attempts; each attempt outcome is logged using OTEL-compliant structured logging (attempt number, delay, error message, timestamp). Persistent failure is surfaced in the admin portal with a manual retry option. The report is also accessible in-app regardless of email delivery status.
- FR-9: The AGM shareable URL does not require any login — it serves the lot owner flow (building selector → AGM list → auth → vote). The building dropdown lists all buildings; AGMs are shown after a building is selected. URL format is at the implementor's discretion (e.g. `/vote/{agm_id}`).
- FR-10: Only one active (open) AGM can exist per building at a time. Creating a second is rejected with a 409 error.
- FR-11: AGM records and their motions are immutable after creation. No edits or deletions are permitted regardless of AGM status (`open` or `closed`). This rule is enforced at the API level.
- FR-12: A building import (US-012) accepts CSV or Excel (.xlsx / .xls), both using headers `building_name` and `manager_email`. It creates a building if one with that name does not exist, or updates `manager_email` if it does. Building names must be globally unique.
- FR-13: Motion selections are held entirely in client-side React state — no draft auto-save to the backend occurs. Selections are transmitted to the backend only when the lot owner clicks Submit and confirms the submission dialog. Voters who never submit are recorded as absent when the AGM is closed. (The backend `PUT /api/general-meeting/{id}/draft` endpoint is retained for backward compatibility but the frontend no longer calls it.) Vote choices are passed **inline** in the `POST /api/general-meeting/{id}/submit` request body as a `votes` list of `{motion_id, choice}` objects. The backend does not read draft Vote rows to determine submitted choices; it uses only the inline votes provided. Any draft Vote rows for the submitting lots are deleted before the submitted Vote rows are inserted, preventing unique-constraint conflicts.
- FR-14: At AGM creation, the system records an immutable weight snapshot (`agm_lot_weights`) containing the `unit_entitlement` of every lot owner in the building at that moment. All tally calculations and the results report use this snapshot exclusively. Subsequent changes to lot owner data (CSV/Excel import, manual edit, PropertyIQ sync) do not alter existing snapshots. The lot owner import uses upsert semantics (matched by `lot_number`) rather than delete-all-then-insert, ensuring that database IDs — and therefore the foreign-key references from `agm_lot_weights` — are preserved for unchanged lots.
- FR-15: The server exposes the current server UTC time via an API endpoint. The voting page fetches this on load, computes the offset from client time, and uses the corrected time for the countdown timer and 5-minute warning to eliminate client clock skew.
- FR-16: Each motion has a `motion_number` (VARCHAR). When explicitly provided by the admin, it is a free-text display label (e.g. "5", "5a", "Special Resolution 1"). When omitted on creation or add-motion, `motion_number` is auto-assigned as `str(display_order)` (e.g. "1", "2", "3"), ensuring every motion always has a non-null number. Whitespace-only input is treated as blank and stored as `NULL`. `motion_number` is unique per AGM (partial unique index `WHERE motion_number IS NOT NULL`) — a duplicate non-null value returns 409. `motion_number` has no effect on display order; reordering motions never modifies `motion_number`. On the voter-facing voting page, every motion card always renders `"MOTION {motion_number}"` as its label. On the confirmation/SubmitDialog, the same `"MOTION {motion_number}"` label is used. A NULL `motion_number` (legacy motions predating the auto-assign feature) causes the UI to fall back to a positional label based on `display_order`.
- FR-17: Motions have a `display_order` (INTEGER, 1-based, unique per meeting) that determines the sequence in which they are rendered on the voting page, public summary, and admin detail pages. The admin can reorder motions via `PUT /api/admin/general-meetings/{id}/motions/reorder` which accepts the complete ordered list of motion IDs and atomically renormalises `display_order` values to 1, 2, 3, ... Reordering is only permitted on open or pending meetings. Changing `display_order` never modifies `motion_number`, and changing `motion_number` never modifies `display_order`.

---

## Non-Functional Requirements

### NFR-PERF-01: Frontend bundle optimisation

The voter-facing JavaScript bundle must not include the `xlsx` library. `xlsx` is used only by the admin motion upload flow and must be loaded lazily (dynamic import) so it is never downloaded by lot owners.

- `xlsx` must be isolated into a separate Rollup chunk (`manualChunks: { xlsx: ["xlsx"] }` in `vite.config.ts`) and imported dynamically from `MotionExcelUpload.tsx`
- The voter bundle (initial JS transferred to a browser opening the voter flow) must not reference the `xlsx` chunk

### NFR-PERF-02: Static asset CDN serving

All Vite-built assets under `/assets/` must be served from Vercel's CDN edge, not the FastAPI Lambda.

- `vercel.json` must set `outputDirectory: "frontend/dist"` so Vercel serves static files directly
- The catch-all rewrite must be scoped so `/assets/` paths are not routed through the Lambda
- All assets under `/assets/(.*)` must be served with `Cache-Control: public, max-age=31536000, immutable` (Vite content-hashes all filenames)

### NFR-PERF-03: Logo optimisation

`frontend/public/logo.png` (201 KB) must be supplemented with a WebP version. All four logo `<img>` references must be wrapped in a `<picture>` element offering `logo.webp` as the preferred source with `logo.png` as fallback, targeting ~60–75% size reduction for WebP-capable browsers.

### NFR-PERF-04: Brotli pre-compression

The Vite build must pre-generate `.br` files for all JS/CSS assets using `vite-plugin-compression`. Vercel's CDN will serve pre-compressed Brotli files to clients that send `Accept-Encoding: br`, reducing transferred payload by ~15–20% over gzip.

---

## Bug Fixes

### BUG-RV-01: Submit button missing after admin makes additional motions visible post-submission

**Status:** Design complete (see `tasks/design/design-fix-revote-submit-button.md`)

**Description:** When a voter has already submitted their ballot and an admin subsequently makes additional motions visible, the voter logs back in and can see the new motions — but the Submit button is absent, and every lot is incorrectly shown as "Already submitted". The voter cannot vote on the new motions.

**Root cause:** The auth endpoint (`POST /api/auth/verify`) computes `already_submitted` per lot based solely on the existence of a `BallotSubmission` row, which is an append-only audit record that is never deleted. A lot that submitted against 3 motions will have `already_submitted = True` even when a 4th motion has since become visible and has not been voted on. Because all lots are flagged as submitted, the `allSubmitted` guard on line 512 of `VotingPage.tsx` suppresses the Submit button, `selectedIds` is initialised empty, and `meeting_lots_<id>` in sessionStorage contains an empty array.

**Fix summary:**

- **Backend (`auth.py`):** Recompute `already_submitted` per lot as "has this lot cast a submitted vote on every currently-visible motion?" (set-subset check) rather than "does a `BallotSubmission` row exist?". Also simplify `unvoted_visible_count` to be consistent with the new per-lot flags.
- **Frontend (`VotingPage.tsx`):** Remove the redundant `!allSubmitted` guard from the Submit button condition. The correct gating condition is `unvotedMotions.length > 0 && !isClosed` — once the backend flag is accurate, `allSubmitted` is never simultaneously `true` when there are unanswered visible motions.
- No database schema changes are required.

**User Stories affected:** US-004 (Vote on motions), US-009 (Vote confirmation screen)

**Acceptance Criteria:**

- [ ] After initial submission, if an admin makes additional motions visible, a returning voter sees those motions as interactive (not read-only) and the Submit button is present
- [ ] Lots that have fully voted on all currently-visible motions continue to display the "Already submitted" badge and their checkboxes remain disabled
- [ ] A voter who has voted on all currently-visible motions and logs back in with no new motions added is still routed to the confirmation page
- [ ] Re-submitting for the new motions does not duplicate previously submitted vote rows; the backend records only the new motion votes
- [ ] The confirmation page after the second submit shows all motions (previously voted and newly voted) with correct choices
- [ ] All tests pass at 100% coverage (backend pytest + frontend vitest)
- [ ] E2E test scenario "revote after new motions made visible" passes

---

### BUG-LS-01: Submitted lots remain selectable after voting and back navigation

**Status:** Design complete (see `tasks/design/design-fix-lot-reselection-after-vote.md`)

**Description:** After a voter submits their ballot for one or more lots and then navigates back to
the voting page (via the Back button, direct URL, or the "Vote for remaining lots" button), all
lots — including ones that were just submitted — are shown as fully interactive. The user can
re-select a submitted lot, fill in choices, and click Submit again. The backend correctly rejects
the duplicate submission with 409, but the user receives no visible error feedback and may believe
their re-vote was recorded.

**Root cause:** `VotingPage.tsx` `submitMutation.onSuccess` (lines 130–133) does not update
`allLots` state or `meeting_lots_info_<meetingId>` in sessionStorage after a successful submission.
When the user navigates back to `/voting`, the page re-mounts and reloads lot state from the stale
sessionStorage, which still has all lots as `already_submitted: false`.

**Fix summary:**

- **Frontend (`VotingPage.tsx`) only — no backend changes required.**
- In `submitMutation.onSuccess`: read the submitted lot IDs from
  `meeting_lots_<meetingId>` in sessionStorage (written by `handleSubmitClick`), call
  `setAllLots` to mark those lots as `already_submitted: true`, write the updated lot list back
  to `meeting_lots_info_<meetingId>` in sessionStorage, and remove the submitted IDs from
  `selectedIds`.

**User Stories affected:** US-004 (Vote on motions), US-009 (Vote confirmation screen)

**Acceptance Criteria:**

- [ ] After submitting for one or more lots, navigating back to the voting page shows submitted
      lots with "Already submitted" badge and disabled checkboxes — not interactive checkboxes
- [ ] The Submit ballot button is absent when all lots have been submitted (no unsubmitted lots
      remain)
- [ ] Unsubmitted lots (in a partial multi-lot submission) remain selectable after the voter
      navigates back to the voting page
- [ ] `meeting_lots_info_<meetingId>` in sessionStorage is updated immediately after a successful
      submission so that subsequent back navigations within the same browser session are consistent
- [ ] A second submit attempt for an already-submitted lot navigates to the confirmation page
      (409 behaviour is unchanged)
- [ ] All tests pass at 100% coverage (backend pytest + frontend vitest)
- [ ] E2E scenarios "submitted lot is disabled after back navigation" and "partial submission —
      remaining lot stays selectable" pass

---

### BUG-RV-02: Previously-voted motions shown as unvoted and without prior answer on re-entry

**Status:** Design complete (see `tasks/design/design-fix-revote-motion-state.md`)

**Description:** When a voter has submitted votes for motions 1, 2, and 3 and an admin subsequently makes motion 4 visible, the voter re-authenticates and correctly reaches the voting page (BUG-RV-01 is fixed). However, motions 1, 2, and 3 display with no pre-selected choice — the vote buttons all appear blank. The voter cannot see what they previously voted and can inadvertently submit different choices for motions that have already been answered (the backend will silently ignore those overrides, but the voter experience is confusing and misleading).

**Root cause:** Two contributing gaps:

1. **Backend** — `GET /api/general-meeting/{id}/motions` returns `already_voted: bool` per motion but does not return the voter's prior `choice` for that motion. There is no way for the frontend to know what was previously selected.
2. **Frontend** — `VotingPage.tsx` always initialises `choices` as an empty object (`{}`). Even if the backend returned the prior choice, the page does not seed `choices` state from it.

**Fix summary:**

- **Backend (`voting.py` router):** Extend `MotionOut` with a new optional field `submitted_choice: VoteChoice | null`. Populate it from the existing submitted-votes query inside `list_motions`. For multi-lot voters where one lot has `not_eligible` and another has a real choice for the same motion, prefer the non-`not_eligible` value.
- **Frontend (`VotingPage.tsx`):** Add a `useEffect` on the `motions` query result that seeds `choices` state with each motion's `submitted_choice` (where non-null and not yet set in state).
- **Frontend (`voter.ts`):** Add `submitted_choice: VoteChoice | null` to the `MotionOut` interface.
- No backend submit logic changes needed — `submit_ballot` already skips already-voted motions.
- No database schema changes required.

**User Stories affected:** US-004 (Vote on motions), US-009 (Vote confirmation screen)

**Acceptance Criteria:**

- [ ] When a voter re-enters the voting page after an admin has made additional motions visible, motions they previously answered display with their original choice pre-selected in the vote buttons
- [ ] Newly visible motions (not yet voted on) display with no pre-selected choice
- [ ] The progress bar reflects only the number of newly unvoted motions (not previously-voted ones)
- [ ] On submit, the backend records votes only for the new motions; previously-voted motions are not overwritten regardless of what the frontend sends
- [ ] The confirmation page after the second submit shows all motions (previously voted and newly voted) with correct choices
- [ ] `GET /api/general-meeting/{id}/motions` returns `submitted_choice: null` for unvoted motions and the correct `VoteChoice` value for voted motions
- [ ] For a multi-lot voter where one lot's general-motion choice is `not_eligible` and another lot's is `yes`, `submitted_choice` returns `yes`
- [ ] All tests pass at 100% coverage (backend pytest + frontend vitest)
- [ ] E2E test scenarios in `design-fix-revote-motion-state.md` pass

---

### BUG-RV-03: Previously-voted motions remain interactive in revote flow instead of being locked

**Status:** Design complete (see `tasks/design/design-fix-revote-motion-state.md`, Phase 2 section)

**Description:** After BUG-RV-02 is fixed (pre-populated prior choices displayed), motions that the voter has already submitted are still rendered as fully interactive — the vote buttons are enabled and the "Already voted" badge does not appear. The voter can change their prior answer, though the backend silently ignores any re-submission for already-voted motions. The expected UX is: previously-voted motions should be locked (disabled vote buttons, "Already voted" badge visible) and only newly revealed unvoted motions should be interactive.

**Root cause:** `isMotionReadOnly` in `VotingPage.tsx` (line 237–238) gates the lock on a per-lot condition (`hasUnsubmittedSelected`) rather than a per-motion condition. When any selected lot has `already_submitted: false` (which is always true in the revote scenario, since the lot has not yet voted on the new visible motion), `isMotionReadOnly` returns `false` for all motions — including ones where `already_voted === true`.

**Fix summary:**

- **Frontend (`VotingPage.tsx`) only.** Replace the `isMotionReadOnly` function body: change `m.already_voted && !hasUnsubmittedSelected` to simply `m.already_voted`. Remove the now-unused `hasUnsubmittedSelected` variable.
- No backend changes required. `already_voted` is already computed correctly by `list_motions`.
- No database schema changes required.
- Phase 2 depends on Phase 1 (BUG-RV-02) — `submitted_choice` must be present to correctly show the locked choice in the read-only card.

**User Stories affected:** US-004 (Vote on motions)

**Acceptance Criteria:**

- [ ] In the revote scenario, motions the voter has previously answered display with the "Already voted" badge and disabled vote buttons
- [ ] In the revote scenario, only newly revealed unvoted motions have interactive vote buttons
- [ ] The progress bar counts only newly unvoted motions (read-only already-voted motions are excluded from the count)
- [ ] Multi-lot voter where Lot A has voted on motions 1–3 but Lot B has not: motions 1–3 remain interactive (because `already_voted` is `false` when any lot has no vote yet)
- [ ] All tests pass at 100% coverage (backend pytest + frontend vitest)
- [ ] E2E Scenario 1 in `design-fix-revote-motion-state.md` (Phase 2) passes

---

### BUG-RV-04: Per-lot per-motion vote status not available to frontend

**Status:** Design complete (see `tasks/design/design-fix-revote-motion-state.md`, Phase 3 section)

**Description:** The auth response (`LotInfo`) currently returns only an `already_submitted` boolean per lot. It does not expose which specific motions each lot has already voted on. Without this data the frontend cannot compute per-lot per-motion locking (needed when a multi-lot voter selects lots with different prior-vote coverage) and cannot detect the mixed-selection condition required for BUG-RV-05.

**Fix summary:**

- **Backend (`auth.py` + `schemas/auth.py`):** Add `voted_motion_ids: list[uuid.UUID]` to `LotInfo`. Populate it from `voted_motion_ids_by_lot` (already computed in both `verify_auth` and `restore_session`). No DB changes required.
- **Frontend (`voter.ts`):** Add `voted_motion_ids: string[]` to the `LotInfo` TypeScript interface.
- No database schema changes required.

**User Stories affected:** US-004 (Vote on motions)

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` returns `voted_motion_ids` on each `LotInfo` object listing the motion IDs where this lot has a submitted vote
- [ ] `POST /api/auth/session` (restore session) also returns `voted_motion_ids` on each `LotInfo`
- [ ] `voted_motion_ids` is empty (`[]`) for a lot that has never submitted any votes
- [ ] `voted_motion_ids` contains only motion IDs where `Vote.status == submitted`; draft votes are excluded
- [ ] The field is included in the `meeting_lots_info_{meetingId}` sessionStorage entry written by `AuthPage`
- [ ] All tests pass at 100% coverage (backend pytest + frontend vitest)

---

### BUG-RV-05: No warning when multi-lot voter selects a mix of voted and unvoted lots

**Status:** Design complete (see `tasks/design/design-fix-revote-motion-state.md`, Phase 3 section)

**Description:** When a multi-lot voter selects lots with different voting histories (some motions already submitted for some lots but not others), there is no indication that previously submitted votes will not be re-recorded. The voter may believe their new answers override prior votes for affected lots — they do not. The backend silently skips already-voted motions per lot. This silent skip is correct behaviour but is not communicated to the voter. This includes the case where both lots are "partial" but with different motion coverage (e.g., Lot A voted motions 1–2 and Lot B voted motions 1–3).

**Fix summary:**

- **Frontend only.** Add a `MixedSelectionWarningDialog` component that appears when the voter clicks "Submit ballot" and any two selected lots have different `voted_motion_ids` sets. The dialog explains the situation, lists the affected lot numbers, and offers "Continue" or "Go back to lot selection".
- The per-lot `voted_motion_ids` data from BUG-RV-04 is the prerequisite for detecting this condition.
- Update `isMotionReadOnly` in `VotingPage.tsx` to use per-lot vote status: a motion is locked when every selected lot has voted on it. If any selected lot has not yet voted on a motion, the motion remains interactive.
- Fresh lots always see blank motion cards — no pre-filling from another lot's prior votes.
- No backend changes required beyond BUG-RV-04. No database schema changes required.
- Depends on BUG-RV-04 (per-lot vote status must be available before this warning can be implemented).

**User Stories affected:** US-004 (Vote on motions)

**Acceptance Criteria:**

- [ ] When the voter clicks "Submit ballot" and any two selected lots have different `voted_motion_ids` sets, a warning dialog is shown before the existing submit confirmation dialog
- [ ] The warning fires even when both lots are "partial" but with different motion coverage (e.g., Lot A voted motions 1–2, Lot B voted motions 1–3)
- [ ] The warning dialog lists the lot numbers of all lots whose `voted_motion_ids` set differs from at least one other selected lot
- [ ] The warning message is: "The lots you have selected have different voting histories — some have already voted on certain motions while others have not. Previously recorded votes are fixed and will not be changed. For each lot, only motions it has not yet voted on will be recorded from this submission. Lots with differing vote histories: [lot numbers]. Do you want to continue?"
- [ ] The dialog offers two actions: "Continue" (proceeds to the existing SubmitDialog) and "Go back to lot selection" (dismisses the dialog, returns focus to the lot panel)
- [ ] The warning is NOT shown when all selected lots have identical `voted_motion_ids` sets (including when all are completely fresh)
- [ ] The warning is NOT shown when only one lot is selected
- [ ] A motion is locked (read-only, "Already voted" badge, disabled buttons) only when ALL currently-selected lots have voted on it; if any selected lot has not yet voted on a motion, the motion remains interactive
- [ ] Fresh lots always see blank motion cards even if another selected lot's `submitted_choice` is non-null for that motion
- [ ] Verify in browser using dev-browser skill
- [ ] All tests pass at 100% coverage (backend pytest + frontend vitest)
- [ ] E2E Scenarios 7, 8, 9, 10, and 11 in `design-fix-revote-motion-state.md` (Phase 3) pass

---

### BUG-MC-01: Motion count display starts at 0 instead of 1

**Status:** Fixed (see `tasks/design/design-fix-motion-count-display.md`)

On the voting screen, motion cards display "Motion N" where N is the raw `order_index` value (0-based). The first motion therefore shows "Motion 0". The fix is a single-line change in `MotionCard.tsx`: display `motion.order_index + 1` instead of `motion.order_index`, making motions read "Motion 1", "Motion 2", etc.

No backend or database changes are required. The `order_index` field remains 0-based in the data model; only the display label is adjusted.

---

---

### US-CFG-01: Admin can view and edit tenant branding settings

**Description:** As a meeting host, I want to configure the app name, logo, primary colour, and support email for my deployment so that the voting app reflects my organisation's identity.

**Acceptance Criteria:**

- [ ] A "Settings" nav item appears in the admin sidebar and navigates to `/admin/settings`
- [ ] The Settings page loads the current config via `GET /api/admin/config` and displays all four fields: App name, Logo URL, Primary colour, Support email
- [ ] Admin can edit any combination of the four fields and save via `PUT /api/admin/config`
- [ ] The form shows "Saving…" on the button while the request is in flight
- [ ] On success, an inline success message "Settings saved" is shown
- [ ] Server-side validation errors are shown inline below the relevant field
- [ ] App name is required; submitting with an empty app name returns 422
- [ ] Primary colour must be a valid 3- or 6-digit CSS hex string (e.g. `#1a73e8`, `#fff`); submitting an invalid value returns 422
- [ ] Logo URL and support email are optional; clearing them saves empty strings (treated as "not set")
- [ ] After a successful save, the admin sidebar branding (app name, logo, primary colour) updates immediately without a page reload — achieved via React Query:  registers the  query key and  invalidates it on save
- [ ] All tests pass at 100% coverage
- [ ] Verify in browser using dev-browser skill

---

### US-CFG-02: Branding config applied app-wide via React context

**Description:** As a voter, I want the app to display the configured app name, logo, and primary colour so that the voting experience matches the host organisation's branding.

**Acceptance Criteria:**

- [ ] On app load, the frontend fetches `GET /api/config` (public, no auth) and stores the result in a `BrandingContext`
- [ ] While the config is loading, the app renders without branding changes (falls back to compile-time defaults)
- [ ] The browser tab title (`<title>`) is set to the configured app name
- [ ] The voter shell header displays the configured logo (as an `<img>`) if `logo_url` is non-empty; if empty, the app name is shown as text instead
- [ ] The admin sidebar header uses the same logo/app name logic as the voter shell
- [ ] The primary colour CSS custom property (`--color-primary`) is updated in the document root when config loads, applying the colour app-wide
- [ ] The support email, if non-empty, is shown on the voter auth page and confirmation page as a "Need help? Contact [email]" link
- [ ] All tests pass at 100% coverage
- [ ] Verify in browser using dev-browser skill

---

### US-CFG-03: Deployment seeded with default branding on first migration

**Description:** As a developer or operator deploying a new instance, I want the system to start with sensible defaults so the app is usable immediately without any manual configuration step.

**Acceptance Criteria:**

- [ ] The Alembic migration that creates `tenant_config` also inserts a single seed row with: `app_name = "AGM Voting"`, `logo_url = ""`, `primary_colour = "#005f73"`, `support_email = ""`
- [ ] The seed row is only inserted if the table is empty (idempotent — re-running the migration does not duplicate the row)
- [ ] `GET /api/config` returns the seed values on a fresh deployment before any admin has edited settings
- [ ] All tests pass at 100% coverage

---

## Non-Goals

- No proxy voting
- No real-time WebSocket updates (polling is sufficient for MVP)
- No live vote dashboard for the manager during the meeting
- No email notifications to lot owners (invites, reminders, vote confirmations)
- No host/manager authentication for MVP — the admin portal is unrestricted (auth is deferred to a future iteration)
- No mobile app (web responsive is acceptable but not required for MVP)
- No audit log or vote history beyond the results report
- No AGM deletion or editing after creation
- No automatic AGM close at `voting_closes_at` — the timer is informational; the manager always closes the AGM manually
- No server-side pagination for admin list views (buildings, lot owners) — client-side pagination with full-list fetch is used for MVP. Revisit if buildings regularly exceed 300+ lot owners or the management company manages hundreds of buildings; at that point implement cursor-based server-side pagination with a `COUNT(*)` total and `?page=&page_size=` query params

---

## Design Considerations

- The lot owner flow (building select → AGM list → auth → vote) should be completable on a mobile browser as lot owners may be attending in person
- The voting page should be clean and unambiguous — large Yes/No/Abstain buttons per motion, with a clear visual distinction for unanswered motions
- The progress bar and countdown timer should be visible at all times on the voting page without requiring the lot owner to scroll
- All date/times displayed in the lot owner UI must be shown in the user's local browser timezone; server stores all times in UTC
- Manager/host admin views can be simple and functional; no design polish required for MVP
- The admin portal and the lot owner flow are served from different routes and should be clearly visually distinct

---

## Technical Considerations

- **Frontend:** React (Vite)
- **Backend:** Python with FastAPI
- **Database:** PostgreSQL
- **ORM:** SQLAlchemy with Alembic for migrations; DB migrations run as a Vercel pre-deploy build step (`buildCommand` in `vercel.json`), not on Lambda cold start. Lambda cold starts require no DB operations.
- **Email:** Resend (transactional email); sender/from address to be confirmed and configured via environment variable
- **Email retry:** Up to 30 retries with exponential backoff; all retry attempts (attempt number, delay, error, timestamp) logged as OTEL-compliant structured log events; delivery status persisted in the database; retry state survives server restarts (stored in DB, re-queued on startup if status is `pending`)
- **Observability:** OTEL-compliant structured logging throughout the backend; covers at minimum: email delivery attempts, AGM status transitions, ballot submissions, and auto-save operations
- **Session management:** Server-side sessions stored in the database (not in-memory) to survive server restarts and support draft vote resumption; session implementation is at the implementor's discretion
- **Draft vote persistence:** Draft votes stored in the `votes` table with `status = draft`, keyed by voter email + AGM ID; promoted to `status = submitted` on formal submission; discarded on AGM close
- **CORS:** Restricted to the frontend origin only; all other origins rejected; configured via environment variable (`ALLOWED_ORIGIN`)
- **Server time API:** A `GET /api/server-time` endpoint returns the current UTC timestamp; used by the frontend to anchor the countdown timer
- **Timezone:** All server-side times stored and computed in UTC; frontend converts to the user's local browser timezone for display using the browser's `Intl` API
- **Environment variables:** Managed via a `.env` file (not committed); a `.env.example` file documents all required variables with placeholder values; minimum required variables: `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `ALLOWED_ORIGIN`, `SESSION_SECRET`
- **CSV parsing:** Python `csv` standard library
- **PMS integration:** PropertyIQ API — API credentials and endpoint details needed before US-006 can be built
- **Deployment:** Not scoped for MVP — local development only
- **Frontend bundle:** `xlsx` (SheetJS) is a production dependency used exclusively in the admin motion-upload flow. It must be lazy-loaded (dynamic import) so it is absent from the voter bundle. See NFR-PERF-01 and `tasks/design/design-perf-bundle-optimisation.md`.
- **Static asset serving:** `vercel.json` must declare `outputDirectory: "frontend/dist"` and serve `/assets/` files from Vercel CDN with immutable cache headers. The Lambda handles only API routes and SPA HTML fallback. See NFR-PERF-02.

---

## Success Metrics

- A complete AGM can be run end-to-end (create → authenticate → vote → close → report) without errors
- Lot owner authentication takes under 30 seconds from opening the link
- Results report email is received within 1 minute of closing the AGM under normal conditions
- A lot owner who re-authenticates after a session interruption sees their previously saved selections restored
- All email retry attempts are visible in structured logs with full context

---

## Open Questions

1. What are the PropertyIQ API credentials and endpoint details needed for the sync integration (US-006)? — **blocked, will revisit later**
2. Should the admin portal be protected by any access mechanism before host authentication is formally scoped? (Currently unrestricted for MVP.)
3. ~~Should the AGM automatically close at `voting_closes_at`, or does the manager always close manually?~~ — **Resolved:** the timer is informational only; the manager always closes the AGM manually via the "Close Voting" button.
4. What is the verified sender email address and domain for Resend? — **pending, to be provided by stakeholder**
