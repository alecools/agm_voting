# PRD: Review Recommendations

## Overview

This PRD captures recommended improvements from a comprehensive 8-perspective engineering review (backend, security, frontend, architecture, QA, legal/compliance, accessibility, SRE). Items are grouped by theme and prioritised. The review covered 47 findings across vote integrity, identity security, operational readiness, accessibility, performance, code quality, and test coverage.

Each section maps findings to user stories with verifiable acceptance criteria. Stories that require schema changes are flagged; stories requiring UI work note browser verification.

---

## 1. Vote Integrity & Legal Compliance

### US-VIL-01: Record absent voters at AGM close

**As a** meeting organiser,
**I want** all non-voting lot owners to have a ballot record created when the meeting closes,
**So that** the audit trail is complete and legally defensible in any post-AGM dispute.

**Acceptance criteria:**
- [ ] When `POST /api/admin/general-meetings/{id}/close` is called, the system identifies all lot owners in the building who have NOT submitted a ballot (based on `GeneralMeetingLotWeight` records minus `BallotSubmission` records)
- [ ] For each absent lot owner, the tally endpoint (`GET /api/admin/general-meetings/{id}`) reports them under the "absent" category for every visible motion, with their snapshotted `unit_entitlement` summed into `absent.entitlement_sum`
- [ ] Absent records appear in the results report (in-app and emailed) under "Absent" per motion
- [ ] The absent count and entitlement sum are stable after close — re-fetching the report returns the same values

**Technical notes:** `backend/app/services/admin_service.py` → `close_general_meeting()` and `get_general_meeting_detail()`. The absent calculation in `get_general_meeting_detail` is already partially present but only for closed meetings; verify it is consistently computed. No schema change required — absent is derived at read time.

**Priority:** P0 | **Effort:** S

---

### US-VIL-02: Prevent cascade-delete of votes via ballot submission deletion

**As a** meeting auditor,
**I want** ballot submissions and votes to be protected from inadvertent deletion,
**So that** a legal challenge cannot succeed by pointing to missing audit records.

**Acceptance criteria:**
- [ ] `Vote` records for submitted ballots are never deleted except via the explicit `reset_general_meeting_ballots` test-only endpoint
- [ ] The `reset_general_meeting_ballots` endpoint (`POST /api/admin/general-meetings/{id}/reset-ballots`) is protected by an environment-variable feature flag (`ENABLE_BALLOT_RESET=true`); it returns 403 in production (default: flag absent or false)
- [ ] The delete cascade from `BallotSubmission` to `Vote` is reviewed; if `ON DELETE CASCADE` exists on the FK from `votes` to `ballot_submissions`, it is removed or converted to `ON DELETE RESTRICT` via migration
- [ ] `DELETE /api/admin/buildings/{id}` (archived building delete) continues to cascade-delete vote records, but only via the building deletion path — which already requires the building to be archived

**Technical notes:** `backend/app/models/`, `backend/alembic/versions/` — may require a migration to change FK constraint. `backend/app/routers/admin.py` — add feature-flag guard on reset endpoint.

**Priority:** P0 | **Effort:** M

---

### US-VIL-03: Tamper detection — cryptographic hash of submitted ballot

**As a** meeting organiser,
**I want** each submitted ballot to carry a tamper-evident hash,
**So that** I can demonstrate in any dispute that the recorded votes have not been altered since submission.

**Acceptance criteria:**
- [ ] `BallotSubmission` gains a `ballot_hash` column (VARCHAR, nullable for backward compatibility)
- [ ] At submission time, the backend computes `SHA-256(json.dumps(sorted votes list))` over the canonical JSON of all submitted `{motion_id, choice}` pairs sorted by `motion_id`, hex-encoded, and stores it in `ballot_hash`
- [ ] `GET /api/admin/general-meetings/{id}` (detail) returns `ballot_hash` per ballot in the voter_lists
- [ ] A utility function `verify_ballot_hash(ballot_submission_id)` re-derives the hash from stored `Vote` records and returns `True` if it matches `ballot_hash`
- [ ] The results report shows a "Ballot integrity verified" indicator per submission when the re-derived hash matches

**Technical notes:** `backend/app/models/ballot_submission.py` — add `ballot_hash` column. `backend/app/services/voting_service.py` — compute hash at submission. Requires Alembic migration.

**Priority:** P1 | **Effort:** M

---

### US-VIL-04: Block vote retraction after submission

**As a** meeting organiser,
**I want** the system to enforce that submitted votes can never be changed or deleted by any code path,
**So that** the legal requirement of ballot finality is guaranteed.

**Acceptance criteria:**
- [ ] `voting_service.submit_ballot()` raises 409 if a `BallotSubmission` already exists for `(general_meeting_id, lot_owner_id)` — this is already the case; confirm test coverage covers this branch
- [ ] There is no API endpoint that accepts `PATCH` or `DELETE` on `Vote` records with `status = submitted`
- [ ] Admin endpoints that could alter votes (e.g., motion delete, building delete) are blocked or guarded against deleting submitted votes belonging to a non-archived, non-test meeting
- [ ] An integration test verifies that a second call to `submit_ballot` for the same lot returns 409 with message "A ballot has already been submitted for this voter"

**Technical notes:** `backend/app/services/voting_service.py`, `backend/app/routers/voting.py`. No schema change required.

**Priority:** P0 | **Effort:** S

---

### US-VIL-05: Special resolution threshold display and audit

**As a** meeting organiser,
**I want** the system to flag motions typed as "Special Resolution" with their statutory threshold (75% of eligible votes),
**So that** the results report makes it clear whether the threshold was met and the outcome is audit-ready.

**Acceptance criteria:**
- [ ] For motions with `motion_type = "special"`, the in-app results report shows a "Special Resolution" label and the statutory threshold: "Requires 75% of eligible weighted votes to pass"
- [ ] The report shows whether the threshold was met: pass (Yes weighted entitlement >= 75% of total eligible entitlement) or fail
- [ ] The emailed HTML report includes the same threshold indicator
- [ ] `GET /api/admin/general-meetings/{id}` response includes a `threshold_met: bool | null` field per motion (null for general motions, true/false for special resolutions)
- [ ] The 75% threshold is a named constant in the backend, not a magic number
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `backend/app/services/admin_service.py` → `get_general_meeting_detail()` and email report generation. `frontend/src/components/admin/AGMReportView.tsx`. No schema change required.

**Priority:** P1 | **Effort:** M

---

### US-VIL-06: Proxy authorisation audit trail

**As a** meeting auditor,
**I want** each proxy vote to carry a record of the proxy authorisation,
**So that** I can demonstrate who authorised the proxy and when, in any post-AGM legal challenge.

**Acceptance criteria:**
- [ ] `BallotSubmission` already stores `proxy_email` — confirm it is populated for proxy votes
- [ ] `LotProxy` records are never deleted after an AGM closes — the proxy nomination that existed at vote time is preserved in `LotProxy` indefinitely
- [ ] The results report for proxy votes shows: lot number, submitting proxy email, and the `submitted_at` timestamp
- [ ] A `GET /api/admin/general-meetings/{id}/ballots` endpoint (or the existing detail endpoint) returns `proxy_email` per ballot submission so the admin can audit which lots were voted by proxy

**Technical notes:** `backend/app/services/admin_service.py`, `backend/app/routers/admin.py`. No schema change required if `proxy_email` is already on `BallotSubmission`.

**Priority:** P1 | **Effort:** S

---

### US-VIL-07: Data retention policy — meeting data lifecycle

**As a** system operator,
**I want** a documented and enforced data retention policy for AGM records,
**So that** the system complies with applicable privacy and corporate governance regulations.

**Acceptance criteria:**
- [ ] A `data_retention_policy.md` document is added to `docs/` stating: ballot submissions and votes are retained for a minimum of 7 years after the AGM date; lot owner PII (email addresses) may be anonymised after 7 years; buildings and meeting metadata are retained indefinitely
- [ ] An admin endpoint `POST /api/admin/general-meetings/{id}/anonymise` is specified (not necessarily implemented in this story) with the behaviour: replace all `voter_email` and `LotOwnerEmail.email` values for the target meeting with anonymised values — this endpoint is gated to super-admin or requires explicit confirmation token
- [ ] The existing `DELETE /api/admin/buildings/{id}` endpoint returns a warning in its response body if the building has closed meetings younger than 7 years, but still proceeds (the caller is responsible for compliance)

**Technical notes:** `docs/` — new policy document. `backend/app/routers/admin.py`. No schema change needed for the warning; anonymisation endpoint requires future work.

**Priority:** P2 | **Effort:** S (policy doc only; anonymisation endpoint is a separate story)

---

### US-VIL-08: Timezone-consistent meeting timestamps in audit log

**As a** meeting auditor,
**I want** all timestamps in reports and audit records to include the UTC offset,
**So that** records are unambiguous regardless of the reviewer's local timezone.

**Acceptance criteria:**
- [ ] All timestamps in the emailed and in-app results report are displayed as ISO 8601 with explicit UTC offset (e.g., `2025-06-15T14:30:00+00:00 UTC`) — not as bare local times
- [ ] `BallotSubmission.submitted_at` is stored as UTC — confirm column is timezone-aware (`TIMESTAMP WITH TIME ZONE`) in the DB; if not, add migration to convert it
- [ ] The admin-facing report includes a note: "All times displayed in UTC"
- [ ] Voter-facing times (voting page, confirmation page) continue to display in browser local time per existing behaviour

**Technical notes:** `backend/alembic/versions/` — verify `submitted_at` timezone; migration if needed. `backend/app/services/admin_service.py` — report formatting. `frontend/src/components/admin/AGMReportView.tsx`.

**Priority:** P1 | **Effort:** S

---

## 2. Identity & Authentication Security

### US-IAS-01: Timing-safe OTP comparison

**As a** security engineer,
**I want** the OTP verification step to use a timing-safe string comparison,
**So that** a remote timing oracle cannot be used to enumerate valid OTP values.

**Acceptance criteria:**
- [ ] `POST /api/auth/verify` uses `hmac.compare_digest(submitted_code, stored_code)` instead of `==` for comparing the OTP code value
- [ ] The comparison happens after the stored OTP row is retrieved; if no row exists the endpoint returns 401 immediately without timing a comparison (no oracle from existence vs. non-existence)
- [ ] A unit test verifies the comparison logic is called with the timing-safe function

**Technical notes:** `backend/app/routers/auth.py` — OTP verification branch.

**Priority:** P0 | **Effort:** S

---

### US-IAS-02: Timing-safe admin login comparison

**As a** security engineer,
**I want** the admin login endpoint to use a timing-safe credential comparison,
**So that** a remote timing oracle cannot enumerate valid admin usernames or passwords.

**Acceptance criteria:**
- [ ] `POST /api/admin/auth/login` uses `hmac.compare_digest()` for both username and password comparisons
- [ ] The response time for a valid username with wrong password is statistically indistinguishable from an invalid username
- [ ] A unit test verifies that `hmac.compare_digest` is used in the login service

**Technical notes:** `backend/app/routers/admin_auth.py` or equivalent login handler.

**Priority:** P0 | **Effort:** S

---

### US-IAS-03: Draft save/get ownership check

**As a** security engineer,
**I want** the draft ballot save and retrieve endpoints to verify session ownership,
**So that** a voter with a valid session cannot read or overwrite another voter's draft.

**Acceptance criteria:**
- [ ] `PUT /api/general-meeting/{id}/draft` verifies that the authenticated session's `voter_email` and `lot_owner_id` match the lot(s) in the request body; returns 403 if not
- [ ] `GET /api/general-meeting/{id}/draft` (if it exists and returns draft votes) verifies session ownership before returning any data
- [ ] The session token is validated before any draft read/write occurs (no unauthenticated draft access)
- [ ] An integration test covers the 403 case: session for voter A cannot read/write draft for voter B

**Technical notes:** `backend/app/routers/voting.py` — draft endpoints. `backend/app/services/auth_service.py` — session validation.

**Priority:** P0 | **Effort:** S

---

### US-IAS-04: Remove session token from response body

**As a** security engineer,
**I want** the session token to be transmitted only as an `HttpOnly` cookie,
**So that** JavaScript running in the page cannot read or exfiltrate the token via XSS.

**Acceptance criteria:**
- [ ] `POST /api/auth/verify` response does NOT include `session_token` as a JSON field in the response body
- [ ] The session token is set exclusively via `Set-Cookie: agm_session=...; HttpOnly; Secure; SameSite=Strict`
- [ ] `POST /api/auth/session` similarly does not return the token in the body
- [ ] The frontend does not store `session_token` in `localStorage` — if it currently does (as per US-PS-01), this story supersedes that behaviour; the persistent session is maintained via `HttpOnly` cookie instead of `localStorage`
- [ ] Session restoration (`POST /api/auth/session`) reads the cookie automatically — no explicit token passing in the request body
- [ ] All existing session-related E2E tests pass with the new cookie-only approach
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `backend/app/routers/auth.py` — `verify_auth` and `restore_session` handlers. `frontend/src/pages/vote/AuthPage.tsx` and `frontend/src/pages/vote/VotingPage.tsx` — remove `localStorage` token handling. This story modifies US-PS-01 behaviour and requires updating its E2E spec.

**Priority:** P0 | **Effort:** M

---

### US-IAS-05: CSRF protection on state-changing endpoints

**As a** security engineer,
**I want** all state-changing API endpoints to require a CSRF token,
**So that** a malicious third-party site cannot trigger vote submissions or admin actions on behalf of an authenticated user.

**Acceptance criteria:**
- [ ] A CSRF token is generated per session and included in the initial HTML page load (or via a `GET /api/csrf-token` endpoint)
- [ ] All `POST`, `PUT`, `PATCH`, `DELETE` requests from the frontend include the CSRF token in a custom request header (e.g., `X-CSRF-Token`)
- [ ] The backend validates the CSRF token on every state-changing request; requests missing or with invalid tokens return 403
- [ ] `GET` requests are excluded from CSRF checks
- [ ] Test endpoints (e.g., `POST /api/test/...`) are excluded in non-production environments only
- [ ] An integration test verifies that a POST without the CSRF token returns 403

**Technical notes:** `backend/app/main.py` — CSRF middleware. `frontend/src/api/` — add CSRF token to all mutation requests. May use `starlette-csrf` or a custom middleware.

**Priority:** P1 | **Effort:** L

---

## 3. Operational Readiness

### US-OPS-01: Service Level Objectives documentation

**As a** system operator,
**I want** SLOs defined for the voter authentication and ballot submission flows,
**So that** I have clear targets for availability and response time that can be monitored.

**Acceptance criteria:**
- [ ] A `docs/slo.md` document defines SLOs for at minimum: voter auth flow (p99 < 2 s), ballot submission (p99 < 2 s), admin close meeting (p99 < 5 s), email report delivery (within 2 min of close under normal conditions)
- [ ] The document specifies the measurement window (rolling 30 days) and error budget (99.5% availability)
- [ ] The document is linked from `README.md` or `CLAUDE.md`

**Technical notes:** `docs/` — new SLO document.

**Priority:** P2 | **Effort:** S

---

### US-OPS-02: Health check endpoint verifies database connectivity

**As a** system operator,
**I want** the health check endpoint to verify live database connectivity,
**So that** deployment smoke tests and uptime monitors catch DB connection failures, not just Lambda startup.

**Acceptance criteria:**
- [ ] `GET /api/health` performs a lightweight DB query (e.g., `SELECT 1`) and returns `{"status": "ok", "db": "connected"}` on success
- [ ] If the DB query fails within a 2-second timeout, the endpoint returns 503 `{"status": "degraded", "db": "unreachable", "error": "<message>"}`
- [ ] The endpoint does not require authentication
- [ ] A unit test mocks a DB failure and verifies the 503 response
- [ ] The endpoint response time is under 500 ms in the healthy case

**Technical notes:** `backend/app/routers/` — new or updated health check route. `backend/app/database.py` — reuse existing `get_db` dependency.

**Priority:** P1 | **Effort:** S

---

### US-OPS-03: Deployment smoke test and rollback runbook

**As a** system operator,
**I want** a defined deployment smoke test checklist and rollback procedure,
**So that** a broken deployment is detected within 5 minutes and can be rolled back without data loss.

**Acceptance criteria:**
- [ ] A `docs/runbooks/deployment.md` document defines: post-deploy smoke test steps (health check URL, create test building, verify OTP flow), rollback procedure (revert Vercel deployment, verify DB migration state), and escalation contacts
- [ ] The smoke test checklist can be executed manually in under 5 minutes
- [ ] The runbook notes that Alembic migrations are not automatically reversed on rollback and specifies that a compensating migration must be created

**Technical notes:** `docs/runbooks/` — new directory and document.

**Priority:** P2 | **Effort:** S

---

### US-OPS-04: Lambda cold start — no blocking operations

**As a** system operator,
**I want** the Lambda cold start to perform no database or network operations,
**So that** cold starts are fast and do not fail due to transient network conditions.

**Acceptance criteria:**
- [ ] `api/index.py` does not execute any DB queries, migrations, or HTTP requests at module import time or outside a request handler
- [ ] DB migrations run only in `buildCommand` (already the case per `vercel.json`); confirm no migration call exists in `api/index.py` startup code
- [ ] A unit test that imports `api.index` completes in under 100 ms with no network calls (mock `asyncpg` if needed)
- [ ] The cold start profile (measured via Vercel function logs) shows no DB connection time outside of the first actual request

**Technical notes:** `api/index.py` — audit for any startup-time blocking calls.

**Priority:** P1 | **Effort:** S

---

### US-OPS-05: Email failure alerting

**As a** system operator,
**I want** to receive an alert when the AGM results email fails all 30 retry attempts,
**So that** I can intervene before the meeting organiser notices and escalates.

**Acceptance criteria:**
- [ ] When `EmailDelivery.status` transitions to `failed` (all 30 retries exhausted), a structured log event is emitted at `ERROR` level with fields: `event=email_delivery_failed`, `general_meeting_id`, `manager_email`, `total_attempts`, `last_error`
- [ ] The admin portal already shows a persistent error banner for failed deliveries (US-007) — confirm this is implemented
- [ ] The structured log event includes enough context for an external alerting system (e.g., Datadog, Sentry) to trigger on `event=email_delivery_failed`
- [ ] An integration test verifies the log event is emitted when status transitions to `failed`

**Technical notes:** `backend/app/services/email_service.py` or the retry loop — add structured log on final failure.

**Priority:** P1 | **Effort:** S

---

### US-OPS-06: Disaster recovery runbook

**As a** system operator,
**I want** a documented disaster recovery procedure for the database,
**So that** data can be recovered within a defined RTO/RPO in the event of a Neon DB incident.

**Acceptance criteria:**
- [ ] A `docs/runbooks/disaster-recovery.md` document defines: RTO (2 hours), RPO (1 hour, based on Neon point-in-time recovery), steps to restore from a Neon branch, steps to re-point Vercel env vars to a restored branch, and a test schedule (quarterly DR drill)
- [ ] The document notes which data would be lost between the last backup and the incident (vote submissions, OTP tokens, session records)

**Technical notes:** `docs/runbooks/` — new document.

**Priority:** P2 | **Effort:** S

---

### US-OPS-07: Auto open/close should not trigger on Lambda cold start

**As a** system operator,
**I want** meeting status transitions (auto-open on `meeting_at`, auto-close on `voting_closes_at`) to be handled by a scheduled process, not by cold-start Lambda execution,
**So that** meetings do not accidentally transition due to a cold start race.

**Acceptance criteria:**
- [ ] The codebase is audited for any code that transitions meeting status at request time based on `meeting_at` or `voting_closes_at` (e.g., a `get_effective_status` call that writes back to the DB)
- [ ] `get_effective_status()` in `backend/app/models/general_meeting.py` is confirmed to be a read-only computed property — it must never write to the DB
- [ ] If any request handler writes a status transition triggered by `get_effective_status`, it is refactored to a scheduled task or explicit admin action only
- [ ] A unit test verifies that `get_effective_status` does not perform any DB writes

**Technical notes:** `backend/app/models/general_meeting.py` — `get_effective_status`. `backend/app/routers/` — audit for writes triggered by status checks.

**Priority:** P1 | **Effort:** S

---

### US-OPS-08: Concurrent vote submission race condition guard

**As a** voter with multiple browser tabs open,
**I want** a second simultaneous ballot submission to be safely rejected,
**So that** duplicate submissions from a race condition do not produce inconsistent DB state.

**Acceptance criteria:**
- [ ] `BallotSubmission` has a unique constraint on `(general_meeting_id, lot_owner_id)` — confirm this exists in the DB schema
- [ ] `voting_service.submit_ballot()` catches the `IntegrityError` from a duplicate insert and raises 409 with message "A ballot has already been submitted for this voter"
- [ ] An integration test spawns two concurrent requests for the same voter and verifies exactly one succeeds (200) and one receives 409
- [ ] The test uses an `asyncio.gather` or equivalent to simulate the race

**Technical notes:** `backend/app/services/voting_service.py`, `backend/app/models/ballot_submission.py`. No schema change if unique constraint already exists.

**Priority:** P0 | **Effort:** M

---

## 4. Accessibility & Usability

### US-ACC-01: Lot checkboxes wrapped in accessible labels

**As a** voter using assistive technology,
**I want** the lot selection checkboxes to be wrapped in properly associated `<label>` elements,
**So that** screen readers announce the lot number when focus lands on the checkbox.

**Acceptance criteria:**
- [ ] Each lot checkbox in the lot sidebar on `VotingPage.tsx` is either wrapped in a `<label>` element or has an `aria-labelledby` pointing to the lot number text
- [ ] Clicking the lot number text also toggles the checkbox (click target includes the label text)
- [ ] Screen reader test: VoiceOver/NVDA announces "Lot [number], checkbox, checked/unchecked" when focus lands on the checkbox
- [ ] All existing lot-checkbox unit and E2E tests pass
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/vote/VotingPage.tsx` — lot sidebar render.

**Priority:** P1 | **Effort:** S

---

### US-ACC-02: Focus trap in modal dialogs

**As a** voter using keyboard navigation,
**I want** keyboard focus to be trapped inside modal dialogs (SubmitDialog, MixedSelectionWarningDialog, DeleteMotionDialog),
**So that** Tab and Shift+Tab cycle within the dialog and do not escape to the page behind it.

**Acceptance criteria:**
- [ ] `SubmitDialog`, `MixedSelectionWarningDialog`, and any admin confirmation modal implement a focus trap: Tab from the last focusable element cycles back to the first; Shift+Tab from the first cycles to the last
- [ ] When a dialog opens, focus is moved to the first focusable element inside it
- [ ] When a dialog closes, focus returns to the element that triggered the dialog
- [ ] Pressing Escape closes the dialog (where semantically appropriate — not on confirmation dialogs where cancellation should be explicit)
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/SubmitDialog.tsx`, `frontend/src/components/vote/MixedSelectionWarningDialog.tsx`. Use `focus-trap-react` library or a custom hook.

**Priority:** P1 | **Effort:** M

---

### US-ACC-03: Focus-visible styling on vote buttons

**As a** voter using keyboard navigation,
**I want** the Yes/No/Abstain vote buttons to show a clear focus ring when focused via keyboard,
**So that** keyboard users can see which button they are about to activate.

**Acceptance criteria:**
- [ ] `VoteButton` component has a visible `:focus-visible` CSS outline that meets WCAG 2.1 AA contrast requirements (at least 3:1 against adjacent colour)
- [ ] The focus indicator is distinct from the selected (active) state so keyboard users can distinguish "I am focused here" from "this button is selected"
- [ ] The focus ring uses `outline` (not `border`) so it does not shift layout
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/VoteButton.tsx` and associated CSS.

**Priority:** P1 | **Effort:** S

---

### US-ACC-04: Colour-independent status indicators

**As a** voter with colour blindness,
**I want** all status indicators (motion highlight for unanswered, voted badge, countdown timer warning) to communicate state through shape or text in addition to colour,
**So that** I can use the app regardless of colour perception.

**Acceptance criteria:**
- [ ] Unanswered motion cards highlighted in amber also show a visible text label or icon (e.g., "Unanswered" badge or "!" icon) in addition to the amber outline
- [ ] The "Already voted" badge on a lot uses text and/or icon, not only a colour change
- [ ] The 5-minute countdown timer warning uses text ("Voting closes soon") and/or an icon in addition to a colour change
- [ ] All indicators pass WCAG 1.4.1 (Use of Colour): information conveyed by colour is also available through another visual cue
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/MotionCard.tsx`, `frontend/src/components/vote/CountdownTimer.tsx`, `frontend/src/pages/vote/VotingPage.tsx`.

**Priority:** P1 | **Effort:** M

---

### US-ACC-05: OTP flow step clarity and accessible instructions

**As a** voter using a screen reader,
**I want** the OTP auth form to clearly announce which step I am on and what is expected,
**So that** I can complete authentication without relying on visual context.

**Acceptance criteria:**
- [ ] The step-1 form (email input) has a visible and programmatically associated heading: "Enter your email to receive a verification code"
- [ ] The step-2 form (code input) has a live region (`aria-live="polite"`) that announces "Verification code sent to [email]" when step 2 is shown
- [ ] The OTP input field has `autocomplete="one-time-code"` and `inputMode="numeric"` (already in US-OTP-02 — verify implemented)
- [ ] Error messages are associated with their input via `aria-describedby`
- [ ] The "Resend code" button is visible without scrolling on the step-2 screen at standard zoom levels
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/AuthForm.tsx`.

**Priority:** P1 | **Effort:** S

---

### US-ACC-06: Admin navigation drawer Escape key dismiss

**As an** admin using keyboard navigation,
**I want** to press Escape to close the admin sidebar drawer on mobile,
**So that** I can dismiss the overlay without using a mouse.

**Acceptance criteria:**
- [ ] When the admin sidebar is open (mobile overlay mode), pressing Escape closes it
- [ ] Focus returns to the hamburger/menu button after the drawer closes via Escape
- [ ] The overlay behind the drawer is clickable and also closes the drawer
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/AdminLayout.tsx`.

**Priority:** P2 | **Effort:** S

---

### US-ACC-07: Skip-to-main-content link

**As a** voter using keyboard navigation,
**I want** a skip link at the top of each page that jumps to the main content area,
**So that** I do not have to Tab through the navigation header on every page load.

**Acceptance criteria:**
- [ ] A `<a href="#main-content" class="skip-link">Skip to main content</a>` link is the first focusable element in the document
- [ ] The link is visually hidden until focused (CSS: position off-screen; on focus: position visible)
- [ ] Clicking or activating the link moves focus to the `<main id="main-content">` element
- [ ] The skip link is present on both voter-facing pages and admin pages
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/VoterShell.tsx`, `frontend/src/pages/admin/AdminLayout.tsx`.

**Priority:** P2 | **Effort:** S

---

### US-ACC-08: Required field markers on forms

**As a** voter or admin using a form,
**I want** required fields to be marked with a visible indicator (asterisk + legend),
**So that** I know which fields I must fill in before submitting.

**Acceptance criteria:**
- [ ] Required fields on the auth form, AGM creation form, lot owner form, and building form show an asterisk (*) next to the label
- [ ] Each form includes a legend: "* Required field" either at the top or bottom of the form
- [ ] The asterisk is not the only indicator — the `required` attribute is also set on the input, and the form shows inline validation when submitted empty
- [ ] Asterisks are aria-hidden (`aria-hidden="true"`) and the label text alone communicates the requirement to screen readers via `aria-required="true"` on the input
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/AuthForm.tsx`, `frontend/src/components/admin/CreateGeneralMeetingForm.tsx`, `frontend/src/components/admin/LotOwnerForm.tsx`, `frontend/src/components/admin/BuildingForm.tsx`.

**Priority:** P2 | **Effort:** M

---

## 5. Performance & Scalability

### US-PER-01: Eliminate N+1 queries in list_lot_owners

**As a** system operator,
**I want** the lot owner list endpoint to use efficient bulk queries,
**So that** a building with 200+ lot owners does not cause 400+ individual DB round trips per request.

**Acceptance criteria:**
- [ ] `admin_service.list_lot_owners()` loads emails and proxy records using a single `IN` query (or JOIN) rather than one query per lot owner
- [ ] The number of DB queries for a building with N lot owners is O(1) or O(log N), not O(N)
- [ ] An integration test with 100+ lot owners verifies the endpoint completes in under 500 ms
- [ ] No functional change to the response shape

**Technical notes:** `backend/app/services/admin_service.py` → `list_lot_owners()`. Use `selectinload` or explicit `IN` queries for `LotOwnerEmail` and `LotProxy`.

**Priority:** P1 | **Effort:** M

---

### US-PER-02: Database connection pool configuration

**As a** system operator,
**I want** the database connection pool to be explicitly configured for the Lambda environment,
**So that** cold starts do not exhaust Neon's connection limit under concurrent load.

**Acceptance criteria:**
- [ ] `asyncpg` / SQLAlchemy engine is configured with `pool_size`, `max_overflow`, and `pool_timeout` values appropriate for a serverless Lambda (recommended: `pool_size=2`, `max_overflow=3`, `pool_timeout=10`)
- [ ] The pool configuration is driven by environment variables (`DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_POOL_TIMEOUT`) with safe defaults
- [ ] A comment in `backend/app/database.py` explains the pool sizing rationale for Lambda
- [ ] A load test or documentation note explains the expected concurrency ceiling

**Technical notes:** `backend/app/database.py` — engine creation.

**Priority:** P1 | **Effort:** S

---

## 6. Code Quality & Maintainability

### US-CQM-01: Deduplicate auth flow logic between verify and session restore

**As a** backend developer,
**I want** the OTP verify and session restore code paths to share a common lot-lookup helper,
**So that** a bug fix or feature addition in lot resolution only needs to be made in one place.

**Acceptance criteria:**
- [x] A private helper function `_resolve_voter_state(db, voter_email, general_meeting_id, building_id)` is extracted from `auth.py`, containing the shared logic: look up lot owners by email, look up proxied lots, fetch visible motions, compute `already_submitted` per lot, compute `voted_motion_ids` per lot, compute `unvoted_visible_count`
- [x] Both `verify_auth` and `restore_session` call this helper
- [x] No change to the public API shape of either endpoint
- [x] All existing auth unit and integration tests pass after the refactor

**Technical notes:** `backend/app/routers/auth.py` — refactor, no schema change.

**Priority:** P2 | **Effort:** M

---

### US-CQM-02: Split admin_service.py into domain-specific modules

**As a** backend developer,
**I want** `admin_service.py` (currently 2300+ lines) split into smaller focused modules,
**So that** individual concerns are easier to find, test, and modify without merge conflicts.

**Acceptance criteria:**
- [ ] `admin_service.py` is split into at minimum: `building_service.py`, `lot_owner_service.py`, `meeting_service.py`, `motion_service.py`, `import_service.py`
- [ ] All existing imports from `admin_service` are updated across routers, tests, and any other consumers
- [ ] `admin_service.py` becomes a re-export shim (or is deleted) so no external interface changes
- [ ] All existing tests pass without modification to test logic (only import paths may change)
- [ ] No functional change

**Technical notes:** `backend/app/services/` — new module files.

**Priority:** P2 | **Effort:** L

---

### US-CQM-03: Decompose VotingPage into sub-components

**As a** frontend developer,
**I want** `VotingPage.tsx` decomposed into smaller focused components,
**So that** the file is under 300 lines and each sub-component is independently testable.

**Acceptance criteria:**
- [ ] `VotingPage.tsx` is refactored to extract at minimum: `LotSidebar` (lot selection panel), `MotionList` (renders all motion cards), `VotingHeader` (meeting title, times, countdown), and `SubmitSection` (submit button + unanswered count)
- [ ] Each extracted component has its own unit test file
- [ ] `VotingPage.tsx` becomes an orchestration shell under 250 lines
- [ ] All existing E2E and unit tests for the voting flow pass after the refactor

**Technical notes:** `frontend/src/pages/vote/VotingPage.tsx` — refactor. New files in `frontend/src/components/vote/`.

**Priority:** P2 | **Effort:** L

---

### US-CQM-04: Replace raw fetch() calls in admin components with API client functions

**As a** frontend developer,
**I want** admin components that currently use inline `fetch()` calls to use typed API client functions instead,
**So that** request construction is centralised and type errors are caught at build time.

**Acceptance criteria:**
- [x] All `fetch()` calls in `frontend/src/api/admin.ts` (identified in audit: `importBuildings`, `importLotOwners`, `importProxyNominations`, `importFinancialPositions`, `deleteGeneralMeeting`, `deleteBuilding`, `deleteMotion`) are replaced with `apiFetch`/`apiFetchVoid` from the shared client. Note: `MotionExcelUpload.tsx` does not call `fetch()` directly and required no change.
- [x] `apiFetchVoid` added to `frontend/src/api/client.ts` for 204 No Content endpoints (delete operations)
- [x] The API functions are typed with request and response TypeScript interfaces
- [x] All existing component tests pass after the refactor

**Technical notes:** `frontend/src/api/` — new or updated API client files. `frontend/src/components/admin/` — replace fetch calls.

**Priority:** P2 | **Effort:** M

---

### US-CQM-05: Deduplicate formatLocalDateTime utility

**As a** frontend developer,
**I want** the date/time formatting logic centralised in a single utility function,
**So that** formatting changes only need to be made in one place.

**Acceptance criteria:**
- [x] A utility function `formatLocalDateTime(isoString: string | null | undefined, options?: Intl.DateTimeFormatOptions): string` is created in `frontend/src/utils/dateTime.ts`
- [x] All places that use inline date/time formatting are updated to call this utility. Actual audit scope (corrected from initial estimate): `VotingPage.tsx`, `GeneralMeetingListItem.tsx`, `GeneralMeetingDetailPage.tsx`, `GeneralMeetingTable.tsx`, `GeneralMeetingSummaryPage.tsx`, `BuildingTable.tsx`. Note: `ConfirmationPage.tsx` and `AGMReportView.tsx` do not perform date formatting and required no change.
- [x] The utility handles null/undefined input by returning an empty string
- [x] Unit tests cover: valid UTC ISO string, null input, undefined input, empty string input, custom format options, and DST boundary

**Technical notes:** `frontend/src/utils/dateTime.ts` — new file. `frontend/src/pages/` and `frontend/src/components/` — update usages.

**Priority:** P2 | **Effort:** S

---

### US-CQM-06: Add missing .motion-card--read-only CSS modifier

**As a** voter in the revote flow,
**I want** previously-voted motion cards to have a visually distinct read-only appearance,
**So that** it is immediately clear which motions I cannot change and which are new.

**Acceptance criteria:**
- [ ] A `.motion-card--read-only` CSS modifier class is defined that applies muted/greyed styling to the card and vote buttons
- [ ] `MotionCard.tsx` applies the `--read-only` modifier when `motion.already_voted === true`
- [ ] The read-only state is distinct from the selected (voted) state — a read-only card with a pre-filled answer shows the answer in a muted style, not the active selected style
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/MotionCard.tsx` and associated CSS.

**Priority:** P1 | **Effort:** S

---

## 7. Test Coverage Gaps

### US-TCG-01: Motion visibility toggle test coverage

**As a** QA engineer,
**I want** comprehensive unit and integration tests for the motion visibility toggle,
**So that** regressions in visibility state transitions are caught automatically.

**Acceptance criteria:**
- [ ] Unit tests for `toggle_motion_visibility()` in `admin_service.py` cover: show hidden motion (success), hide visible motion without votes (success), hide visible motion with votes (409), toggle on closed meeting (409), motion not found (404)
- [ ] Integration tests for `PATCH /api/admin/motions/{id}/visibility` cover the same states against a real test DB
- [ ] Frontend unit tests for the visibility toggle in `MotionManagementTable.tsx` cover: initial state (hidden/visible), clicking toggle triggers API call, optimistic update on click, revert on API error, disabled when meeting is closed
- [ ] All new tests pass at 100% coverage

**Technical notes:** `backend/tests/test_admin_service.py`, `backend/tests/test_routers_admin.py`, `frontend/src/components/admin/__tests__/MotionManagementTable.test.tsx`.

**Priority:** P0 | **Effort:** M

---

### US-TCG-02: Concurrent ballot submission integration test

**As a** QA engineer,
**I want** an integration test that simulates two simultaneous ballot submissions from the same voter,
**So that** the unique-constraint race condition guard (US-OPS-08) is verified to work.

**Acceptance criteria:**
- [ ] An integration test in `backend/tests/` uses `asyncio.gather` to send two `POST /api/agm/{id}/submit` requests concurrently for the same `(meeting_id, lot_owner_id)` pair
- [ ] The test asserts that exactly one request returns 200 and one returns 409
- [ ] The test asserts that the DB contains exactly one `BallotSubmission` row for the pair after both requests complete
- [ ] The test runs against the local test DB and is included in the standard test suite

**Technical notes:** `backend/tests/test_routers_voting.py` or a new `test_concurrent_voting.py`.

**Priority:** P0 | **Effort:** M

---

### US-TCG-03: Email failure during AGM close — integration test

**As a** QA engineer,
**I want** an integration test that verifies correct behaviour when the email service fails during meeting close,
**So that** the admin error banner and retry mechanism work as designed.

**Acceptance criteria:**
- [ ] An integration test mocks the email service to raise an exception during `close_general_meeting`
- [ ] The test verifies: the meeting status is still set to `closed`, an `EmailDelivery` record is created with `status = failed`, the API returns 200 (close succeeds even if email fails)
- [ ] A second test verifies that `POST /api/admin/general-meetings/{id}/resend-report` transitions the delivery back to `pending` and re-queues the send
- [ ] All new tests pass

**Technical notes:** `backend/tests/test_admin_service.py` or `test_routers_admin.py`.

**Priority:** P1 | **Effort:** M

---

### US-TCG-04: E2E test — closed meeting auth flow

**As a** QA engineer,
**I want** an E2E test that covers the voter auth flow against a closed meeting,
**So that** the "already closed" routing to confirmation page is verified in a real browser.

**Acceptance criteria:**
- [ ] A Playwright test covers: voter navigates to auth page for a closed meeting → enters email → enters OTP → is routed to confirmation page showing "This meeting is closed" or the confirmation screen depending on whether they voted
- [ ] The test seeds a closed meeting via API before running
- [ ] The test covers both sub-cases: voter who submitted before close (sees their votes) and voter who did not submit (sees absent message)
- [ ] The existing Voter persona E2E spec (`e2e/voter.spec.ts` or equivalent) is updated — not just supplemented with a separate file
- [ ] All E2E tests pass

**Technical notes:** `frontend/e2e/` — update voter spec. Follows the pattern in CLAUDE.md: "When a change affects an existing journey, update the existing tests for that journey."

**Priority:** P1 | **Effort:** M

---

### US-TCG-05: Serialise E2E tests to prevent inter-test interference

**As a** QA engineer,
**I want** the E2E test suite to run tests that share meeting/building state serially,
**So that** parallel test workers do not corrupt shared state and cause flaky failures.

**Acceptance criteria:**
- [ ] Tests that create, open, vote against, and close the same meeting are grouped in a `test.describe.serial` block (Playwright) or given a unique per-test meeting via API seed
- [ ] Each test seeds its own data via API calls and cleans up after itself (existing rule from CLAUDE.md)
- [ ] The test suite produces zero flaky failures over 3 consecutive runs against the preview environment
- [ ] `playwright.config.ts` is reviewed; if `workers > 1` is set, either the data isolation is confirmed sufficient or affected tests are made serial

**Technical notes:** `frontend/e2e/` — test organisation. `playwright.config.ts`.

**Priority:** P1 | **Effort:** M

---

### US-TCG-06: QA gap review — missing test scenarios list

**As a** QA engineer,
**I want** a living document that tracks known test gaps,
**So that** the team has visibility into untested scenarios and can prioritise test additions.

**Acceptance criteria:**
- [ ] A `docs/test-gaps.md` document lists all known untested scenarios identified in the review, with: scenario description, level (unit/integration/E2E), current status (not implemented/partial/complete), and assigned priority
- [ ] The document includes at minimum the scenarios identified in the review: motion visibility toggle edge cases, concurrent ballot submission, email failure during close, closed meeting auth flow, lot owner list N+1 performance
- [ ] The document is maintained as a living checklist — items are checked off when tests are added
- [ ] The document is linked from `CLAUDE.md` under the Testing Standards section

**Technical notes:** `docs/test-gaps.md` — new document.

**Priority:** P2 | **Effort:** S

---

## 8. Review Round 2 — New Findings (Recent Features)

These user stories capture bugs and gaps discovered during the second review pass, covering pagination, the archived-buildings filter, motion number assignment, cookie security, and the voter confirmation receipt audit trail.

---

### RR2-01: Pagination `is_archived` filter ignored in `list_buildings`

**As an** admin viewing the buildings list,
**I want** the archived/active filter to correctly limit which buildings are returned by the backend,
**So that** the paginated results do not intermix archived and active buildings causing sparse or incorrect pages.

**Acceptance criteria:**
- [ ] `admin_service.list_buildings()` accepts an `is_archived: bool` parameter and applies `q.where(Building.is_archived == is_archived)` before computing the total count and fetching the page
- [ ] `GET /api/admin/buildings?is_archived=false&page=1&page_size=20` returns only active buildings; `is_archived=true` returns only archived buildings
- [ ] The `total` count in the response reflects only the filtered set, not all buildings
- [ ] Existing pagination behaviour (page, page_size, offset) is unchanged
- [ ] Integration tests cover: filter=false (active only), filter=true (archived only), and mixed DB state where both types exist

**Technical notes:** `backend/app/services/admin_service.py:245` — `list_buildings()`. The filter parameter is currently accepted on the router but silently dropped before the query is constructed.

**Priority:** P0 | **Effort:** S

---

### RR2-02: Motion number auto-assign 409 conflict when display_order collides with existing manual number

**As an** admin adding a motion without specifying a motion number,
**I want** auto-assigned motion numbers to never conflict with existing manually-set motion numbers,
**So that** the insert does not fail with an unexpected 409 error.

**Acceptance criteria:**
- [ ] `admin_service.create_motion()` auto-assigns `motion_number` by computing `max(existing motion_number values cast to int) + 1`, not by using `str(display_order)`
- [ ] If no motions exist yet, auto-assignment starts at `1`
- [ ] If the max existing `motion_number` is non-numeric (manually set to a label like "A"), auto-assignment falls back to `max(display_order values) + 1`
- [ ] A unit test covers: auto-assign with no existing motions, auto-assign when display_order equals an existing manual motion_number (previously caused 409), and auto-assign with non-numeric existing motion numbers
- [ ] No 409 is ever raised for the auto-assign path

**Technical notes:** `backend/app/services/admin_service.py:1379` — motion creation auto-assign logic.

**Priority:** P0 | **Effort:** S

---

### RR2-03: Toggling archived filter does not reset pagination to page 1

**As an** admin browsing the buildings list,
**I want** the page number to reset to 1 whenever I toggle the archived/active filter,
**So that** I do not land on an empty or incorrect page when the filtered set has fewer pages than my current page.

**Acceptance criteria:**
- [ ] Toggling the "Show archived" filter resets the current page to `1` before issuing the new API request
- [ ] The same reset behaviour applies to any other filter controls on paginated list pages (status filter on meeting list, etc.)
- [ ] After reset, the URL search param `page` is set to `1` (or removed if 1 is the default)
- [ ] A frontend unit test verifies that the page state is reset to 1 when the filter value changes
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/` — buildings list page and any other paginated list pages that have filter controls.

**Priority:** P1 | **Effort:** S

---

### RR2-04: HttpOnly cookie `Secure=True` flag breaks localhost development

**As a** backend developer,
**I want** the session cookie's `Secure` flag to be conditionally set based on the environment,
**So that** authentication works on `http://localhost` during local development without requiring HTTPS.

**Acceptance criteria:**
- [ ] `backend/app/routers/auth.py` sets `secure=True` on the session cookie only when `settings.testing_mode` is `False` (i.e., in production/preview deployments)
- [ ] In local development (`testing_mode=True` or a new `settings.is_local_dev` flag), the cookie is set with `secure=False`
- [ ] The change applies to all `set_cookie` calls in `auth.py` (at minimum lines 399 and 578)
- [ ] The `HttpOnly` and `SameSite=Strict` attributes remain set in all environments — only `Secure` is conditional
- [ ] A unit test verifies that `secure=False` is used when `testing_mode=True` and `secure=True` when `testing_mode=False`

**Technical notes:** `backend/app/routers/auth.py:399, 578`. The `settings` object already has a `testing_mode` flag that can be reused.

**Priority:** P1 | **Effort:** S

---

### RR2-05: Pagination component missing ARIA attributes

**As a** voter or admin using assistive technology,
**I want** the pagination control to have correct ARIA attributes,
**So that** screen readers announce the current page, total pages, and individual page buttons correctly.

**Acceptance criteria:**
- [ ] Each page button has an `aria-label` (e.g., `aria-label="Page 3"`)
- [ ] The active/current page button has `aria-current="page"`
- [ ] The results container (the table or list that updates on page change) has `aria-live="polite"` so screen readers announce when content changes
- [ ] Previous/Next buttons have descriptive `aria-label` values ("Previous page", "Next page") not just icon content
- [ ] Disabled Previous/Next buttons have `aria-disabled="true"` in addition to the `disabled` attribute
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/` — the shared Pagination component introduced with the pagination feature.

**Priority:** P1 | **Effort:** S

---

### RR2-06: Pagination state not reflected in URL search params

**As an** admin on a paginated list page,
**I want** the current page number to be stored in the URL,
**So that** refreshing the page or sharing the URL preserves the current page.

**Acceptance criteria:**
- [ ] The `page` query param is added to the URL when navigating to a non-first page (e.g., `?building=5&status=open&page=3`)
- [ ] On initial load, the page number is read from the URL `page` param and used as the initial state
- [ ] Navigating to a different page updates the URL without adding a new browser history entry (use `replace` not `push`)
- [ ] Refreshing the page at `?page=3` loads page 3, not page 1
- [ ] This applies to all paginated list pages: buildings list and general meeting list at minimum
- [ ] The existing `building` and `status` URL params continue to work alongside `page`
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/GeneralMeetingListPage.tsx` and buildings list page. Use `useSearchParams` from React Router alongside existing filter param handling.

**Priority:** P1 | **Effort:** M

---

### RR2-07: No loading indicator when changing pages

**As an** admin navigating between pages,
**I want** a loading indicator while the next page of results is fetching,
**So that** the UI does not silently go blank and I know a request is in progress.

**Acceptance criteria:**
- [ ] While `isLoading` is `true` on a page-change request, the table area shows a spinner or skeleton rows instead of disappearing
- [ ] The pagination controls are disabled (or visually inert) while loading to prevent double-clicks
- [ ] Once loading completes, the spinner/skeleton is replaced by the new results
- [ ] The loading state is distinct from the initial empty-state (no results found) — a message like "No buildings found" only appears when the request has completed and returned an empty list
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/` — buildings list and meeting list pages. Check if a shared `TableSkeleton` or spinner component already exists in the design system before creating a new one.

**Priority:** P2 | **Effort:** S

---

### RR2-08: Hidden motions omitted from voter confirmation receipt (legal audit gap)

**As a** voter who has already submitted a ballot,
**I want** my confirmation page to show all motions I voted on, even if an admin later hides a motion,
**So that** my confirmation receipt accurately reflects what I submitted and cannot be silently altered after the fact.

**Acceptance criteria:**
- [ ] `voting_service.get_my_ballot()` fetches motions based on the voter's actual `Vote` records, not on the current `Motion.is_visible` filter
- [ ] Motions that have been hidden after submission are included in the confirmation page response; they may be labelled "(hidden)" to distinguish them from currently visible motions
- [ ] A voter who voted on 5 motions (3 now visible, 2 now hidden) sees all 5 on their confirmation page
- [ ] An admin who hides a motion after votes are submitted does not alter any voter's confirmation receipt — the `get_my_ballot` response is stable regardless of subsequent visibility changes
- [ ] Integration test: submit a ballot covering motions A, B, C; hide motion B; call `get_my_ballot`; assert all three motions appear in the response
- [ ] The existing voter confirmation page E2E spec is updated to include a scenario covering a hidden motion appearing in the receipt

**Technical notes:** `backend/app/services/voting_service.py:519` — `get_my_ballot()`. The fix is to JOIN `Vote` records to their `Motion` rows without filtering on `Motion.is_visible`, or to use the `Vote.motion_id` set as the driving filter rather than the motion list. This is a legal/audit issue: a voter's proof of vote must be immutable from their perspective.

**Priority:** P0 | **Effort:** M

---

## 9. Review Round 3 — Critical Findings (Second Team Review)

These user stories capture critical issues surfaced by the second 8-perspective team review. Items already covered by earlier stories are noted inline. Runtime bug fixes (C-2, C-7, C-8, C-9) have a companion design doc: `tasks/design/design-critical-runtime-bugs.md`.

---

### RR3-01: Gate `testing_mode` security bypasses at startup in production

**As a** security engineer,
**I want** the application to refuse to start if `testing_mode=true` in a non-development environment,
**So that** OTP rate-limiting, cookie security, and test endpoints can never be accidentally disabled in production.

**Acceptance criteria:**
- [ ] `backend/app/config.py` startup validator raises `ValueError` if `testing_mode=True` and `environment` is not `"development"` or `"testing"`
- [ ] `OtpRequestBody.skip_email` field returns 422 if `skip_email=true` and `settings.testing_mode` is `False`, regardless of caller
- [ ] `GET /api/test/latest-otp` returns 404 (not 403) when `testing_mode=False` — the route does not exist in production, not merely returns forbidden
- [ ] A unit test verifies the startup validator raises on misconfiguration
- [ ] A unit test verifies `skip_email=true` with `testing_mode=False` returns 422

**Technical notes:** `backend/app/config.py` — add `@model_validator`. `backend/app/routers/auth.py` — conditional route registration or request-level guard on `skip_email`. `backend/app/schemas/auth.py`.

**Priority:** P0 | **Effort:** S

---

### RR3-02: Prevent permanent deletion of closed AGM records

**As a** meeting auditor,
**I want** closed meetings to be undeletable,
**So that** a completed legal vote record cannot be destroyed via the admin API.

**Acceptance criteria:**
- [ ] `DELETE /api/admin/general-meetings/{id}` returns 409 if the meeting's status is `closed`; the error body explains that closed meeting records are immutable
- [ ] Open or pending meetings may still be deleted (existing behaviour preserved)
- [ ] A unit test and integration test cover the 409 case for a closed meeting
- [ ] CLAUDE.md Architecture & Design Decisions is updated to note: "Closed meetings are immutable and cannot be deleted via API"

**Technical notes:** `backend/app/services/admin_service.py` — `delete_general_meeting()`. `backend/app/routers/admin.py`. No schema change required.

**Priority:** P0 | **Effort:** S

---

### RR3-03: Vote submission must not produce orphaned Vote records

**As a** meeting auditor,
**I want** every Vote row in the database to have a corresponding BallotSubmission,
**So that** vote tallies accurately reflect only completed, submitted ballots.

**Acceptance criteria:**
- [ ] The `SELECT FOR UPDATE` lock in `submit_ballot()` covers the entire vote-building and flush sequence — `Vote` rows are inserted within the same locked transaction as the `BallotSubmission` insert
- [ ] A concurrent integration test (two simultaneous submissions for the same lot) verifies that after both requests complete, the DB contains exactly the votes belonging to the one successful submission — no orphaned Vote rows exist
- [ ] `Vote` rows with no matching `BallotSubmission` are detectable via a DB query; a new admin debug endpoint or migration check verifies zero orphans in existing data
- [ ] All existing ballot submission tests pass

**Technical notes:** See `tasks/design/design-critical-runtime-bugs.md` (C-8) for the fix. `backend/app/services/voting_service.py` lines 225–510.

**Priority:** P0 | **Effort:** M

---

### RR3-04: Email delivery must be idempotent — no duplicate sends

**As a** meeting organiser,
**I want** the AGM results email to be sent exactly once per meeting close,
**So that** a Lambda restart or a concurrent close attempt does not cause the manager to receive duplicate emails.

**Acceptance criteria:**
- [ ] A distributed lock (Neon advisory lock keyed on `agm_id`) prevents two concurrent email retry tasks from sending for the same meeting
- [ ] If the Lambda restarts before the `EmailDelivery.status` is updated to `sent`, the re-queued task on restart detects the send has already occurred (via `status=sent`) and does not re-send
- [ ] An integration test verifies: close meeting → mock send → interrupt before status commit → restart → assert email sent exactly once and `EmailDelivery.status = sent`
- [ ] All existing email delivery tests pass

**Technical notes:** See `tasks/design/design-critical-runtime-bugs.md` (C-9). `backend/app/services/email_service.py` lines 176–306.

**Priority:** P0 | **Effort:** M

---

### RR3-05: DB connection pool must handle Lambda cold-start autoscaling

**As a** system operator,
**I want** the application to handle DB connection exhaustion gracefully during Lambda autoscaling,
**So that** a traffic spike that cold-starts multiple Lambda instances simultaneously does not produce cascading 503s during a live AGM.

**Acceptance criteria:**
- [ ] `get_db()` retries connection acquisition up to 3 times with 100 ms / 200 ms / 400 ms backoff before raising a 503
- [ ] A 503 response from DB exhaustion includes a `Retry-After: 1` header
- [ ] `backend/app/config.py` documents the maximum safe concurrency: `pool_size × max_overflow × max_Lambda_instances ≤ Neon_connection_limit`
- [ ] A load test scenario (documented in `docs/runbooks/database-connectivity.md`) describes the expected behaviour at the connection ceiling

**Technical notes:** `backend/app/database.py` — `get_db()` dependency. `backend/app/config.py` — concurrency ceiling comment. Extends US-PER-02.

**Priority:** P0 | **Effort:** S

---

### RR3-06: Admin status badges must meet WCAG AA colour contrast

**As an** admin with low vision,
**I want** status badge text in the admin portal to meet WCAG AA contrast requirements,
**So that** I can reliably read meeting and building status at a glance.

**Acceptance criteria:**
- [ ] `StatusBadge.tsx` badge colours achieve ≥ 4.5:1 text-to-background contrast ratio for all states (open, pending, closed)
- [ ] Inline `style` props are replaced with CSS classes that use design system variables (per design system rules)
- [ ] A comment in the CSS documents the verified contrast ratios for each state
- [ ] Verify contrast with a browser accessibility tool (e.g., Chrome DevTools accessibility panel)

**Technical notes:** `frontend/src/components/admin/StatusBadge.tsx:10-18`. Read `tasks/design/design-system.md` before changing colours.

**Priority:** P0 | **Effort:** S

---

### RR3-07: Admin confirmation modals require focus traps and Escape dismiss

**As an** admin using keyboard navigation,
**I want** all admin confirmation modals to trap focus and respond to Escape,
**So that** keyboard navigation is consistent across the admin portal.

**Acceptance criteria:**
- [ ] `ArchiveConfirmModal` and `BuildingEditModal` in `BuildingDetailPage.tsx` implement the same focus trap + Escape pattern as `DeleteBuildingConfirmModal`
- [ ] When a modal opens, focus moves to the first focusable element inside it
- [ ] Tab and Shift+Tab cycle within the modal; focus cannot escape to content behind it
- [ ] Pressing Escape closes the modal (even during a loading/async state for non-destructive modals; confirmation modals may keep Escape disabled during the in-flight operation)
- [ ] Focus returns to the button that triggered the modal on close
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/BuildingDetailPage.tsx` — `ArchiveConfirmModal` and `BuildingEditModal`. Extends US-ACC-02 which covers voter-facing modals; this story covers admin modals.

**Priority:** P0 | **Effort:** S

---

### RR3-08: Alerting infrastructure required before production

**As a** system operator,
**I want** alerts configured on key health signals before the app handles real AGMs,
**So that** SLO breaches are detected automatically rather than reported by users.

**Acceptance criteria:**
- [ ] `docs/slo.md` is updated with the chosen alerting mechanism (e.g., Vercel log drains → Datadog/Better Uptime/similar)
- [ ] Alert rules are defined and documented for: health check returning 503 (5+ consecutive), `event=email_delivery_failed` log event, DB connection pool exhaustion log event
- [ ] An on-call runbook section is added to `docs/runbooks/incident-response.md` (or equivalent) listing escalation contacts and response SLAs
- [ ] At minimum, a simple uptime monitor (e.g., Better Uptime, UptimeRobot) pings `GET /api/health` every 60 seconds and alerts on consecutive failures

**Technical notes:** `docs/slo.md`, `docs/runbooks/`. No code changes required — this is infrastructure and documentation.

**Priority:** P0 | **Effort:** M

---

### RR3-09: Proxy re-submission test coverage

**As a** QA engineer,
**I want** the proxy voter re-submission flow to be tested end-to-end,
**So that** a proxy voter who re-authenticates after submission is correctly routed to the confirmation page and blocked from re-voting.

**Acceptance criteria:**
- [ ] A backend integration test verifies: proxy voter submits ballot → `BallotSubmission.proxy_email` is set in DB (assert the value, not just that the row exists) → second submission attempt returns 409
- [ ] An E2E test (new workflow WF-PROXY-REENTRY): proxy voter authenticates → votes → re-authenticates → is routed to confirmation page, not the voting form
- [ ] The existing WF6 proxy voting E2E spec is updated to assert `proxy_email` in the submitted ballot response
- [ ] All new tests pass

**Technical notes:** `backend/tests/test_phase2_api.py` — proxy submission section. `frontend/e2e/workflows/voting-scenarios.spec.ts` — add WF-PROXY-REENTRY. `backend/app/services/voting_service.py` — confirm `proxy_email` is written on ballot submission.

**Priority:** P0 | **Effort:** M

---

### RR3-10: Proxy voter with in-arrear lots test coverage

**As a** QA engineer,
**I want** a test covering the intersection of proxy voting and in-arrear lot eligibility,
**So that** the `not_eligible` recording logic is verified for proxy-submitted in-arrear lots.

**Acceptance criteria:**
- [ ] A backend integration test covers: proxy voter submits ballot for two lots — lot A (normal) and lot B (in-arrear) — on a meeting with a General Motion; verifies lot A records a normal vote choice and lot B records `not_eligible` for the General Motion
- [ ] An E2E test (new workflow WF-PROXY-ARREAR): proxy authenticates with an in-arrear lot → General Motion shows `not_eligible` indicator → ballot submits → confirmation shows correct split
- [ ] All new tests pass

**Technical notes:** `backend/tests/test_phase2_api.py`. `frontend/e2e/workflows/voting-scenarios.spec.ts` — add WF-PROXY-ARREAR. Requires seeding a building with one proxy relationship where the proxied lot has `financial_position = in_arrear`.

**Priority:** P0 | **Effort:** M

---

## Priority Summary

| Theme | P0 | P1 | P2 | Total |
|-------|----|----|-----|-------|
| Vote Integrity & Legal Compliance | 2 | 4 | 2 | 8 |
| Identity & Authentication Security | 3 | 1 | 0 | 5 |
| Operational Readiness | 1 | 4 | 3 | 8 |
| Accessibility & Usability | 0 | 5 | 3 | 8 |
| Performance & Scalability | 0 | 2 | 0 | 2 |
| Code Quality & Maintainability | 0 | 1 | 5 | 6 |
| Test Coverage Gaps | 2 | 3 | 1 | 6 |
| Review Round 2 — New Findings | 3 | 4 | 1 | 8 |
| Review Round 3 — Critical Findings | 10 | 0 | 0 | 10 |
| **Totals** | **21** | **24** | **15** | **61** |

> Round 3 adds 10 new stories (RR3-01 through RR3-10) covering critical issues from the second 8-perspective team review. C-1 (session token in body) is already covered by US-IAS-04. C-6 (building deletion cascade) is accepted behaviour per US-VIL-02. C-12 (voter modal focus traps) is covered by US-ACC-02; RR3-07 extends it to admin modals. Runtime bug fixes for C-2, C-7, C-8, C-9 are in `tasks/design/design-critical-runtime-bugs.md`.

---

## Non-Goals

- No automatic meeting close at `voting_closes_at` — this is out of scope per the main PRD non-goals; US-OPS-07 only prevents cold-start writes, not scheduling auto-close
- No OAuth or SSO — OTP flow is the intended auth mechanism
- No real-time WebSocket notifications — polling remains the approach
- No server-side pagination — addressed in the main PRD non-goals
- No mobile app

---

## Open Questions

1. Should US-IAS-04 (remove session token from response body) be implemented before or after all existing E2E tests are updated? The change breaks the `localStorage` session restore in US-PS-01 and requires coordinated frontend and backend changes.
2. For US-VIL-03 (ballot hash), should the hash be computed over all votes including `not_eligible` choices, or only `yes/no/abstained`?
3. For US-IAS-05 (CSRF), should the CSRF token be delivered via a cookie (double-submit cookie pattern) or via a `GET /api/csrf-token` endpoint? The cookie approach is simpler for SPA + API deployments on the same domain.
4. For US-VIL-07 (data retention), what is the applicable Australian state legislation for body corporate AGM records? (Likely Body Corporate and Community Management Act 1997 QLD or equivalent state act — confirm with legal before implementing anonymisation.)
