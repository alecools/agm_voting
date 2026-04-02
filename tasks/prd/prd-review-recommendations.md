# PRD: Review Recommendations

## Overview

This PRD captures recommended improvements from a comprehensive 8-perspective engineering review (backend, security, frontend, architecture, QA, legal/compliance, accessibility, SRE). Items are grouped by theme and prioritised. The review covered 47 findings across vote integrity, identity security, operational readiness, accessibility, performance, code quality, and test coverage.

Each section maps findings to user stories with verifiable acceptance criteria. Stories that require schema changes are flagged; stories requiring UI work note browser verification.

---

## 1. Vote Integrity & Legal Compliance

### US-VIL-01: Record absent voters at AGM close

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status: ✅ Implemented**

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

**Status:** ✅ Implemented

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

### US-VIL-06: Proxy authorisation audit trail

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

### US-IAS-04: Remove session token from response body

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

**As a** QA engineer,
**I want** comprehensive unit and integration tests for the motion visibility toggle,
**So that** regressions in visibility state transitions are caught automatically.

**Acceptance criteria:**
- [x] Unit tests for `toggle_motion_visibility()` in `admin_service.py` cover: show hidden motion (success), hide visible motion without votes (success), hide visible motion with votes (409), toggle on closed meeting (409), motion not found (404)
- [x] Integration tests for `PATCH /api/admin/motions/{id}/visibility` cover the same states against a real test DB
- [x] Frontend unit tests for the visibility toggle in `MotionManagementTable.tsx` cover: initial state (hidden/visible), clicking toggle triggers API call, optimistic update on click, revert on API error, disabled when meeting is closed
- [x] All new tests pass at 100% coverage

**Technical notes:** `backend/tests/test_admin_service.py`, `backend/tests/test_routers_admin.py`, `frontend/src/components/admin/__tests__/MotionManagementTable.test.tsx`.

**Priority:** P0 | **Effort:** M

---

### US-TCG-02: Concurrent ballot submission integration test

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

**As a** QA engineer,
**I want** an integration test that verifies correct behaviour when the email service fails during meeting close,
**So that** the admin error banner and retry mechanism work as designed.

**Acceptance criteria:**
- [x] An integration test mocks the email service to raise an exception during `close_general_meeting`
- [x] The test verifies: the meeting status is still set to `closed`, an `EmailDelivery` record is created with `status = failed`, the API returns 200 (close succeeds even if email fails)
- [x] A second test verifies that `POST /api/admin/general-meetings/{id}/resend-report` transitions the delivery back to `pending` and re-queues the send
- [x] All new tests pass

**Technical notes:** `backend/tests/test_admin_service.py` or `test_routers_admin.py`.

**Priority:** P1 | **Effort:** M

---

### US-TCG-04: E2E test — closed meeting auth flow

**Status:** ✅ Implemented

**As a** QA engineer,
**I want** an E2E test that covers the voter auth flow against a closed meeting,
**So that** the "already closed" routing to confirmation page is verified in a real browser.

**Acceptance criteria:**
- [x] A Playwright test covers: voter navigates to auth page for a closed meeting → enters email → enters OTP → is routed to confirmation page showing "This meeting is closed" or the confirmation screen depending on whether they voted
- [x] The test seeds a closed meeting via API before running
- [x] The test covers both sub-cases: voter who submitted before close (sees their votes) and voter who did not submit (sees absent message)
- [x] The existing Voter persona E2E spec (`e2e/voter.spec.ts` or equivalent) is updated — not just supplemented with a separate file
- [x] All E2E tests pass

**Technical notes:** `frontend/e2e/` — update voter spec. Follows the pattern in CLAUDE.md: "When a change affects an existing journey, update the existing tests for that journey."

**Priority:** P1 | **Effort:** M

---

### US-TCG-05: Serialise E2E tests to prevent inter-test interference

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

**As a** QA engineer,
**I want** a living document that tracks known test gaps,
**So that** the team has visibility into untested scenarios and can prioritise test additions.

**Acceptance criteria:**
- [x] A `docs/test-gaps.md` document lists all known untested scenarios identified in the review, with: scenario description, level (unit/integration/E2E), current status (not implemented/partial/complete), and assigned priority
- [x] The document includes at minimum the scenarios identified in the review: motion visibility toggle edge cases, concurrent ballot submission, email failure during close, closed meeting auth flow, lot owner list N+1 performance
- [x] The document is maintained as a living checklist — items are checked off when tests are added
- [x] The document is linked from `CLAUDE.md` under the Testing Standards section

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

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As an** admin adding a motion without specifying a motion number,
**I want** auto-assigned motion numbers to never conflict with existing manually-set motion numbers,
**So that** the insert does not fail with an unexpected 409 error.

**Acceptance criteria:**
- [x] `admin_service.create_motion()` auto-assigns `motion_number` by computing `max(existing motion_number values cast to int) + 1`, not by using `str(display_order)`
- [x] If no motions exist yet, auto-assignment starts at `1`
- [x] If the max existing `motion_number` is non-numeric (manually set to a label like "A"), auto-assignment falls back to `max(display_order values) + 1`
- [x] A unit test covers: auto-assign with no existing motions, auto-assign when display_order equals an existing manual motion_number (previously caused 409), and auto-assign with non-numeric existing motion numbers
- [x] No 409 is ever raised for the auto-assign path

**Technical notes:** `backend/app/services/admin_service.py:1379` — motion creation auto-assign logic.

**Priority:** P0 | **Effort:** S

---

### RR2-03: Toggling archived filter does not reset pagination to page 1

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As an** admin browsing the buildings list,
**I want** the page number to reset to 1 whenever I toggle the archived/active filter,
**So that** I do not land on an empty or incorrect page when the filtered set has fewer pages than my current page.

**Acceptance criteria:**
- [x] Toggling the "Show archived" filter resets the current page to `1` before issuing the new API request
- [x] The same reset behaviour applies to any other filter controls on paginated list pages (status filter on meeting list, etc.)
- [x] After reset, the URL search param `page` is set to `1` (or removed if 1 is the default)
- [x] A frontend unit test verifies that the page state is reset to 1 when the filter value changes
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/` — buildings list page and any other paginated list pages that have filter controls.

**Priority:** P1 | **Effort:** S

---

### RR2-04: HttpOnly cookie `Secure=True` flag breaks localhost development

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As a** backend developer,
**I want** the session cookie's `Secure` flag to be conditionally set based on the environment,
**So that** authentication works on `http://localhost` during local development without requiring HTTPS.

**Acceptance criteria:**
- [x] `backend/app/routers/auth.py` sets `secure=True` on the session cookie only when `settings.testing_mode` is `False` (i.e., in production/preview deployments)
- [x] In local development (`testing_mode=True` or a new `settings.is_local_dev` flag), the cookie is set with `secure=False`
- [x] The change applies to all `set_cookie` calls in `auth.py` (at minimum lines 399 and 578)
- [x] The `HttpOnly` and `SameSite=Strict` attributes remain set in all environments — only `Secure` is conditional
- [x] A unit test verifies that `secure=False` is used when `testing_mode=True` and `secure=True` when `testing_mode=False`

**Technical notes:** `backend/app/routers/auth.py:399, 578`. The `settings` object already has a `testing_mode` flag that can be reused.

**Priority:** P1 | **Effort:** S

---

### RR2-05: Pagination component missing ARIA attributes

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As a** voter or admin using assistive technology,
**I want** the pagination control to have correct ARIA attributes,
**So that** screen readers announce the current page, total pages, and individual page buttons correctly.

**Acceptance criteria:**
- [x] Each page button has an `aria-label` (e.g., `aria-label="Page 3"`)
- [x] The active/current page button has `aria-current="page"`
- [x] The results container (the table or list that updates on page change) has `aria-live="polite"` so screen readers announce when content changes
- [x] Previous/Next buttons have descriptive `aria-label` values ("Previous page", "Next page") not just icon content
- [x] Disabled Previous/Next buttons have `aria-disabled="true"` in addition to the `disabled` attribute
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/` — the shared Pagination component introduced with the pagination feature.

**Priority:** P1 | **Effort:** S

---

### RR2-06: Pagination state not reflected in URL search params

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As an** admin on a paginated list page,
**I want** the current page number to be stored in the URL,
**So that** refreshing the page or sharing the URL preserves the current page.

**Acceptance criteria:**
- [x] The `page` query param is added to the URL when navigating to a non-first page (e.g., `?building=5&status=open&page=3`)
- [x] On initial load, the page number is read from the URL `page` param and used as the initial state
- [x] Navigating to a different page updates the URL without adding a new browser history entry (use `replace` not `push`)
- [x] Refreshing the page at `?page=3` loads page 3, not page 1
- [x] This applies to all paginated list pages: buildings list and general meeting list at minimum
- [x] The existing `building` and `status` URL params continue to work alongside `page`
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/GeneralMeetingListPage.tsx` and buildings list page. Use `useSearchParams` from React Router alongside existing filter param handling.

**Priority:** P1 | **Effort:** M

---

### RR2-07: No loading indicator when changing pages

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As an** admin navigating between pages,
**I want** a loading indicator while the next page of results is fetching,
**So that** the UI does not silently go blank and I know a request is in progress.

**Acceptance criteria:**
- [x] While `isLoading` is `true` on a page-change request, the table area shows a spinner or skeleton rows instead of disappearing
- [x] The pagination controls are disabled (or visually inert) while loading to prevent double-clicks
- [x] Once loading completes, the spinner/skeleton is replaced by the new results
- [x] The loading state is distinct from the initial empty-state (no results found) — a message like "No buildings found" only appears when the request has completed and returned an empty list
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/pages/admin/` — buildings list and meeting list pages. Check if a shared `TableSkeleton` or spinner component already exists in the design system before creating a new one.

**Priority:** P2 | **Effort:** S

---

### RR2-08: Hidden motions omitted from voter confirmation receipt (legal audit gap)

**Status:** ✅ Implemented — branch: `fix/rr2-02-08`, committed 2026-03-31

**As a** voter who has already submitted a ballot,
**I want** my confirmation page to show all motions I voted on, even if an admin later hides a motion,
**So that** my confirmation receipt accurately reflects what I submitted and cannot be silently altered after the fact.

**Acceptance criteria:**
- [x] `voting_service.get_my_ballot()` fetches motions based on the voter's actual `Vote` records, not on the current `Motion.is_visible` filter
- [x] Motions that have been hidden after submission are included in the confirmation page response; they may be labelled "(hidden)" to distinguish them from currently visible motions
- [x] A voter who voted on 5 motions (3 now visible, 2 now hidden) sees all 5 on their confirmation page
- [x] An admin who hides a motion after votes are submitted does not alter any voter's confirmation receipt — the `get_my_ballot` response is stable regardless of subsequent visibility changes
- [x] Integration test: submit a ballot covering motions A, B, C; hide motion B; call `get_my_ballot`; assert all three motions appear in the response
- [ ] The existing voter confirmation page E2E spec is updated to include a scenario covering a hidden motion appearing in the receipt

**Technical notes:** `backend/app/services/voting_service.py:519` — `get_my_ballot()`. The fix is to JOIN `Vote` records to their `Motion` rows without filtering on `Motion.is_visible`, or to use the `Vote.motion_id` set as the driving filter rather than the motion list. This is a legal/audit issue: a voter's proof of vote must be immutable from their perspective.

**Priority:** P0 | **Effort:** M

---

## 9. Review Round 3 — Critical Findings (Second Team Review)

These user stories capture critical issues surfaced by the second 8-perspective team review. Items already covered by earlier stories are noted inline. Runtime bug fixes (C-2, C-7, C-8, C-9) have a companion design doc: `tasks/design/design-critical-runtime-bugs.md`.

---

### RR3-01: Gate `testing_mode` security bypasses at startup in production

**Status:** ✅ Implemented — branch: `fix/rr3-01-testing-mode-gate`, committed 2026-03-31

**As a** security engineer,
**I want** the application to refuse to start if `testing_mode=true` in a non-development environment,
**So that** OTP rate-limiting, cookie security, and test endpoints can never be accidentally disabled in production.

**Acceptance criteria:**
- [x] `backend/app/config.py` startup validator raises `ValueError` if `testing_mode=True` and `environment` is not `"development"` or `"testing"`
- [ ] `OtpRequestBody.skip_email` field returns 422 if `skip_email=true` and `settings.testing_mode` is `False`, regardless of caller
- [ ] `GET /api/test/latest-otp` returns 404 (not 403) when `testing_mode=False` — the route does not exist in production, not merely returns forbidden
- [x] A unit test verifies the startup validator raises on misconfiguration
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

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** system operator,
**I want** the application to handle DB connection exhaustion gracefully during Lambda autoscaling,
**So that** a traffic spike that cold-starts multiple Lambda instances simultaneously does not produce cascading 503s during a live AGM.

**Acceptance criteria:**
- [x] `pool_size=1, max_overflow=0` set in `backend/app/config.py` — each Lambda holds exactly 1 connection, supporting up to 25 concurrent instances before hitting Neon's 25-connection limit
- [x] `backend/app/database.py` updated with rationale comment documenting the Lambda-appropriate pool defaults
- [x] `backend/app/config.py` documents the pool settings with inline comments
- [x] Unit tests verify `settings.db_pool_size == 1`, `settings.db_max_overflow == 0`, and engine pool size == 1

**Technical notes:** `backend/app/database.py` — `get_db()` dependency. `backend/app/config.py` — concurrency ceiling comment. Extends US-PER-02.

**Priority:** P0 | **Effort:** S

---

### RR3-06: Admin status badges must meet WCAG AA colour contrast

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

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

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** QA engineer,
**I want** the proxy voter re-submission flow to be tested end-to-end,
**So that** a proxy voter who re-authenticates after submission is correctly routed to the confirmation page and blocked from re-voting.

**Acceptance criteria:**
- [x] Backend integration test `TestProxyResubmission` verifies: proxy voter submits ballot → `BallotSubmission.proxy_email` set in DB → second submission returns 200 (idempotent re-entry) with empty votes list
- [x] Test `test_proxy_ballot_submission_stores_proxy_email` confirms proxy_email is stored in DB
- [x] All new tests pass

**Technical notes:** `backend/tests/test_phase2_api.py` — `TestProxyResubmission` class added at end of file.

**Priority:** P0 | **Effort:** M

---

### RR3-10: Proxy voter with in-arrear lots test coverage

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** QA engineer,
**I want** a test covering the intersection of proxy voting and in-arrear lot eligibility,
**So that** the `not_eligible` recording logic is verified for proxy-submitted in-arrear lots.

**Acceptance criteria:**
- [x] Backend integration test `TestProxyVoterInArrearNotEligible` covers: proxy voter submits ballot for in-arrear lot with General Motion → vote recorded as `not_eligible`
- [x] Companion test verifies in-arrear lot on Special Motion records the actual voter choice (not `not_eligible`)
- [x] Tests include correct `GeneralMeetingLotWeight` snapshot setup with `financial_position_snapshot=in_arrear`
- [x] All new tests pass

**Technical notes:** `backend/tests/test_phase2_api.py` — `TestProxyVoterInArrearNotEligible` class added at end of file.

**Priority:** P0 | **Effort:** M

---

---

## 10. Review Round 3 — High Findings

---

### RR3-11: Raw exceptions must not appear in HTTP error responses

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** security engineer,
**I want** all error responses to return generic messages rather than raw exception strings,
**So that** internal infrastructure details (DB driver errors, stack traces, bcrypt internals) are never leaked to clients.

**Acceptance criteria:**
- [x] `SecurityHeadersMiddleware.dispatch` in `main.py` catches unhandled exceptions, logs full traceback server-side, and returns `{"detail": "An internal error occurred"}` with status 500
- [x] `@app.exception_handler(Exception)` registered as belt-and-suspenders fallback
- [x] Unit test `test_security_middleware_catches_unhandled_exception_returns_500` verifies 500 with generic message for route exceptions
- [x] Test `test_global_exception_handler_function_directly` exercises the exception handler registration
- [x] All existing tests pass

**Technical notes:** `backend/app/main.py` — `SecurityHeadersMiddleware.dispatch` + `global_exception_handler`.

**Priority:** P0 | **Effort:** S

---

### RR3-12: Eliminate N+1 queries in ballot submission and building archive

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

**As a** system operator,
**I want** the ballot submission and building archive paths to use batched queries,
**So that** a building with 147 lots does not issue 294+ DB round-trips per submission.

**Acceptance criteria:**
- [ ] `voting_service.submit_ballot()` ownership verification fetches all `LotOwnerEmail` and `LotProxy` records for the full `lot_owner_ids` set in two `IN` queries before the loop — eliminates up to 2N queries; `voting_service.py:194`
- [ ] `voting_service.submit_ballot()` already-voted lookup is replaced with a single `IN` query grouped in Python — eliminates N queries; `voting_service.py:240`
- [ ] `admin_service.archive_building()` email + other-building lookup is batch-loaded with `IN` queries outside the loop — eliminates N×M queries; `admin_service.py:322`
- [ ] `admin_service.get_general_meeting_detail()` email fetch inside the weight-row loop is replaced with a single pre-loaded batch; `admin_service.py:1303`
- [ ] Integration test verifies submission with 50+ lots completes in < 500 ms

**Technical notes:** `backend/app/services/voting_service.py`, `backend/app/services/admin_service.py`. Extends US-PER-01.

**Priority:** P0 | **Effort:** M

---

### RR3-13: Transaction boundaries in admin login must be atomic

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** security engineer,
**I want** the rate-limit record and login result to be committed in the same transaction,
**So that** a partial failure cannot advance the rate-limit counter without recording the login outcome.

**Acceptance criteria:**
- [x] `SELECT AdminLoginAttempt ... .with_for_update()` in `admin_auth.py` locks the row for the duration of the transaction, ensuring check + write are atomic (RR3-13)
- [x] Rate-limit check and record creation remain in the same implicit transaction — no intermediate commits between SELECT FOR UPDATE and INSERT/UPDATE
- [x] Tests `TestRateLimitAtomicity::test_failed_login_creates_attempt_record` and `test_repeated_failed_logins_increment_counter` verify atomic counter increments
- [x] All existing admin auth tests pass

**Technical notes:** `backend/app/routers/admin_auth.py` — added `with_for_update()` to SELECT query.

**Priority:** P1 | **Effort:** S

---

### RR3-14: Hidden motions must be excluded from the public summary endpoint

**As a** meeting organiser,
**I want** `GET /api/general-meeting/{id}/summary` to exclude motions with `is_visible=False`,
**So that** pre-vote motion text is not disclosed to voters before the organiser makes it visible.

**Acceptance criteria:**
- [ ] The query in `public.py` filters `Motion.is_visible == True` before returning motions
- [ ] An integration test verifies: create meeting with one visible and one hidden motion → call summary endpoint → only visible motion appears in response
- [ ] A closed meeting returns all motions regardless of visibility (audit use case — confirmed with product)

**Technical notes:** `backend/app/routers/public.py:117-142`.

**Priority:** P0 | **Effort:** S

---

### RR3-15: Admin rate-limit must use forwarded client IP, not proxy IP

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** security engineer,
**I want** admin login rate-limiting to key on the real client IP,
**So that** brute-force attempts through a CDN or load balancer are not pooled into a single shared rate-limit window.

**Acceptance criteria:**
- [x] `get_client_ip(request)` helper added to `admin_auth.py` — reads first IP from `X-Forwarded-For`, falls back to `request.client.host`, returns `"unknown"` if neither present
- [x] `admin_login` uses `get_client_ip(request)` instead of `request.client.host`
- [x] Code comment documents that Vercel sets `X-Forwarded-For` correctly for Lambda functions
- [x] `TestGetClientIp` unit tests verify all cases: single IP, chain, whitespace stripping, fallback to client.host, fallback to "unknown"
- [x] Integration test verifies rate-limit record stored under forwarded IP

**Technical notes:** `backend/app/routers/admin_auth.py` — `get_client_ip()` helper + updated `admin_login`.

**Priority:** P1 | **Effort:** S

---

### RR3-16: Eliminate email enumeration timing oracle in auth flow

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** security engineer,
**I want** the OTP request path to execute the same DB queries regardless of whether the email is registered,
**So that** an attacker cannot enumerate valid lot owner emails by measuring response times.

**Acceptance criteria:**
- [x] `POST /api/auth/verify` calls `hmac.compare_digest(request.code, request.code)` even when no OTP row is found — ensures timing-safe comparison always executes regardless of OTP presence
- [x] Both "OTP found but code wrong" and "OTP not found" paths call `hmac.compare_digest` before raising 401
- [x] Test `TestAuthTimingOracle::test_verify_always_calls_hmac_compare_digest` verifies the fix via source inspection

**Technical notes:** `backend/app/routers/auth.py` — dummy `hmac.compare_digest` call added in the `otp is None` branch.

**Priority:** P1 | **Effort:** S

---

### RR3-17: `admin_password_validator` must actually validate bcrypt format

**Status:** ✅ Implemented — branch: `fix/wave1-security-reliability`, committed 2026-03-31

**As a** backend developer,
**I want** the `ADMIN_PASSWORD` env var to be rejected at startup if it is not a valid bcrypt hash,
**So that** a misconfigured deployment with a plaintext password is caught before the first request.

**Acceptance criteria:**
- [x] `admin_password_must_be_bcrypt` validator in `config.py` raises `ValueError` if value is non-empty, not the dev placeholder `"admin"`, and does not start with `$2b$` or `$2a$`
- [x] `TestAdminPasswordValidator` verifies: `$2b$` hash accepted, `$2a$` hash accepted, `"admin"` dev placeholder accepted, empty string accepted, plaintext `"mysecretpassword"` rejected, wrong prefix `"$1$..."` rejected, random string `"changeme"` rejected

**Technical notes:** `backend/app/config.py` — `admin_password_must_be_bcrypt` validator updated. `backend/tests/test_app.py` — `TestAdminPasswordValidator` class added.

**Priority:** P0 | **Effort:** S

---

### RR3-18: Draft votes must be retained for audit rather than deleted

**As a** meeting auditor,
**I want** draft votes to be archived rather than deleted when a ballot is submitted or a meeting closes,
**So that** there is a complete audit record of state transitions from draft to submitted.

**Acceptance criteria:**
- [ ] `Vote` model gains a `deleted_at: datetime | None` column (nullable, indexed) — requires Alembic migration
- [ ] `voting_service.submit_ballot()` sets `deleted_at = now()` on superseded drafts rather than executing a hard `DELETE`
- [ ] `admin_service.close_general_meeting()` sets `deleted_at = now()` on remaining drafts rather than hard-deleting them
- [ ] All queries that read active votes filter `Vote.deleted_at == None` — no functional change to tallies or confirmation page
- [ ] An audit query `SELECT * FROM votes WHERE deleted_at IS NOT NULL` returns the archived drafts
- [ ] All existing tests pass; a new unit test verifies drafts appear in the audit query

**Technical notes:** `backend/app/models/vote.py`, `backend/alembic/versions/`, `backend/app/services/voting_service.py:321`, `backend/app/services/admin_service.py:1929`. Schema change required.

**Priority:** P1 | **Effort:** M

---

### RR3-19: Email retry `asyncio.Task`s must not be silently dropped at Lambda exit

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

**As a** system operator,
**I want** the email retry mechanism to survive Lambda cold-start cycles,
**So that** a meeting closed during a Lambda cycle does not silently lose its email delivery.

**Acceptance criteria:**
- [ ] `requeue_pending_on_startup()` at `main.py:43` is replaced or supplemented with a cron-triggered endpoint `POST /api/internal/retry-pending-emails` that is called on a schedule (e.g., every 5 minutes via Vercel cron or external scheduler)
- [ ] The endpoint requires a shared secret header (`X-Internal-Secret`) to prevent unauthenticated calls
- [ ] Background `asyncio.Task`s are only used as a best-effort optimisation within the current Lambda invocation; the cron provides the reliable retry path
- [ ] `docs/runbooks/email-delivery-failures.md` is updated to document the cron schedule and manual trigger procedure

**Technical notes:** `backend/app/main.py:43`, `backend/app/services/email_service.py`. `vercel.json` — add cron job entry.

**Priority:** P1 | **Effort:** M

---

### RR3-20: Build-time migration must verify success before Lambda starts

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

**As a** system operator,
**I want** the Lambda to refuse to serve requests if the DB schema is not at the expected revision,
**So that** a failed migration during build does not silently serve requests against a stale schema.

**Acceptance criteria:**
- [ ] `api/index.py` checks the current Alembic revision via `alembic current` (or direct DB query on `alembic_version`) at startup
- [ ] If the current revision does not match the head revision baked into the build, the Lambda raises `RuntimeError` on the first request (blocking all traffic until a correct deploy is promoted)
- [ ] The check is fast (< 100 ms) — a direct `SELECT version_num FROM alembic_version` query, not a full `alembic upgrade head` run
- [ ] A unit test verifies the startup check raises on revision mismatch

**Technical notes:** `api/index.py`.

**Priority:** P1 | **Effort:** S

---

### RR3-21: Structured logging required on all critical paths

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

**As a** system operator,
**I want** every significant state transition and permission denial to emit a structured log event,
**So that** incidents can be diagnosed from logs without attaching a debugger.

**Acceptance criteria:**
- [ ] `voting_service.submit_ballot()` logs: `event=ballot_submitted`, `voter_email`, `agm_id`, `lot_count`; and on 403: `event=ballot_denied`, `reason`
- [ ] `admin_service.close_general_meeting()` logs: `event=meeting_closed`, `agm_id`, `lot_count`, `absent_count`, `email_triggered`
- [ ] `auth_service._unsign_token()` logs at WARNING on `SignatureExpired` or `BadSignature`: `event=session_token_invalid`, `reason`
- [ ] All log events include `request_id` (once correlation IDs are added per RR3-42)
- [ ] A unit test for each path verifies the log event is emitted using `structlog.testing.capture_logs`

**Technical notes:** `backend/app/services/voting_service.py`, `backend/app/services/admin_service.py`, `backend/app/services/auth_service.py`.

**Priority:** P1 | **Effort:** M

---

### RR3-22: Feature branch cleanup must be idempotent and failure-safe

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

**As a** developer,
**I want** branch cleanup (Neon DB branch + Vercel env vars) to be wrapped in an idempotent script,
**So that** a partial failure does not leave orphaned infrastructure that silently breaks the next branch with the same name.

**Acceptance criteria:**
- [ ] A `scripts/cleanup-feature-branch.sh` script wraps the four cleanup steps from `CLAUDE.md` with: existence checks before delete, error logging, and a final verification that all resources are removed
- [ ] The script is idempotent — running it twice on the same branch produces no errors
- [ ] On any step failure, the script exits non-zero and prints which resource was not cleaned
- [ ] The cleanup agent's instructions in CLAUDE.md reference this script rather than raw curl commands

**Technical notes:** `scripts/cleanup-feature-branch.sh` — new file. `CLAUDE.md` — update cleanup commands reference.

**Priority:** P2 | **Effort:** S

---

### RR3-23: Connection string must be validated at application startup

**Status:** ✅ Implemented — branch: `fix/wave3-ops-observability`, committed 2026-03-31

**As a** system operator,
**I want** the application to reject a malformed `DATABASE_URL` at startup,
**So that** a misconfigured env var produces a clear error at deploy time rather than a cryptic runtime failure.

**Acceptance criteria:**
- [ ] `config.py` adds a `@field_validator("database_url")` that rejects: URLs containing `channel_binding`, URLs using `sslmode=` instead of `ssl=`, URLs not starting with `postgresql+asyncpg://`
- [ ] The Lambda raises `ValueError` at cold start if validation fails — the deploy is visibly broken before any voter request is served
- [ ] A unit test verifies each rejection case

**Technical notes:** `backend/app/config.py`. Complements the runtime sanitisation in `api/index.py:36-47`.

**Priority:** P1 | **Effort:** S

---

### RR3-24: `MultiChoiceOptionList` must use `<fieldset>`/`<legend>` for screen readers

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

**As a** voter using a screen reader,
**I want** multi-choice option groups to be announced as a named group,
**So that** I understand that the checkboxes belong together and how many I can select.

**Acceptance criteria:**
- [ ] `MultiChoiceOptionList.tsx` wraps all checkboxes in a `<fieldset>` with a `<legend>` containing the selection limit text (e.g., "Select up to 3 options")
- [ ] The visible counter paragraph (`"N selected"`) retains `aria-hidden="true"` to avoid double-announcement
- [ ] Screen reader test: VoiceOver/NVDA announces the group legend when focus enters the first checkbox
- [ ] All existing multi-choice unit and E2E tests pass
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/MultiChoiceOptionList.tsx:33-60`.

**Priority:** P1 | **Effort:** S

---

### RR3-25: `VoteButton` must have a reliable accessible name independent of icon

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

**As a** voter using a screen reader,
**I want** each vote button's accessible name to be unambiguous,
**So that** I can distinguish "For", "Against", and "Abstain" without relying on the icon character.

**Acceptance criteria:**
- [ ] Each `VoteButton` has an `aria-label={`Vote: ${LABELS[choice]}`}` that provides a self-contained accessible name
- [ ] The `vote-btn__label` span remains visible in the DOM and is not hidden via `aria-hidden`
- [ ] Keyboard test: Tab to a vote button → screen reader announces "Vote: For, button" (or equivalent)
- [ ] Verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/VoteButton.tsx:25-40`.

**Priority:** P1 | **Effort:** S

---

### RR3-26: Admin routes must have an `ErrorBoundary` to handle chunk load failures

**Status:** ✅ Implemented — branch: `fix/wave2-accessibility`, committed 2026-03-31

**As an** admin,
**I want** a meaningful error message when a lazy-loaded admin page fails to load,
**So that** a CDN or network error does not leave me staring at an infinite spinner.

**Acceptance criteria:**
- [ ] The `<Suspense>` wrapper around lazy-loaded admin routes in `App.tsx` is wrapped in a React `ErrorBoundary`
- [ ] On chunk load failure, the `ErrorBoundary` renders a fallback: "Failed to load page — please refresh" with a retry button
- [ ] The `ErrorBoundary` catches only `ChunkLoadError`; other errors propagate normally
- [ ] A unit test renders the boundary with a mocked failing lazy component and verifies the fallback is shown

**Technical notes:** `frontend/src/App.tsx:33-40`.

**Priority:** P1 | **Effort:** S

---

### RR3-27: Building search on `VotingPage` must handle all-query-failure gracefully

**As a** voter,
**I want** the voting page to show a clear error if it cannot find my meeting,
**So that** I am not left with a blank meeting header and no indication of what went wrong.

**Acceptance criteria:**
- [x] If all `fetchGeneralMeetings` calls complete without finding the `meetingId`, `VotingPage` renders an error state: "Meeting not found — please check the link and try again"
- [x] The error state is shown instead of a blank/undefined meeting header
- [x] A unit test mocks all building queries returning empty results and verifies the error state renders

**Technical notes:** `frontend/src/pages/vote/VotingPage.tsx:94-113`.

**Priority:** P1 | **Effort:** S

---

### RR3-28: Lot owner email input must use `type="email"`

**As an** admin entering lot owner details,
**I want** the email field to use `type="email"`,
**So that** the browser validates format, provides the correct mobile keyboard, and autocomplete works correctly.

**Acceptance criteria:**
- [x] `LotOwnerForm.tsx` email input uses `type="email"` instead of `type="text"`
- [x] Browser native validation is not suppressed (no `noValidate` on the parent form without a replacement)
- [x] Existing unit tests for the form pass after the change

**Technical notes:** `frontend/src/components/admin/LotOwnerForm.tsx:527`.

**Priority:** P1 | **Effort:** S

---

### RR3-29: Server time fetch must have a timeout

**As a** voter,
**I want** the countdown timer to fall back gracefully if the server time endpoint is slow,
**So that** a single slow network request does not block the voting UI indefinitely.

**Acceptance criteria:**
- [x] `useServerTime.ts` wraps the fetch in `AbortController` with a 5-second timeout
- [x] On timeout or network error, the hook falls back to `Date.now()` and logs a warning
- [x] A unit test verifies the fallback is used when the fetch times out

**Technical notes:** `frontend/src/hooks/useServerTime.ts:13-24`.

**Priority:** P1 | **Effort:** S

---

### RR3-30: Partial vote re-submission after session expiry must be tested

**As a** QA engineer,
**I want** a test verifying that a voter who submits partially, re-authenticates, and re-submits is handled correctly,
**So that** the partial-then-complete submission path does not corrupt the ballot.

**Acceptance criteria:**
- [x] Integration test: voter submits motion 1 of 2 → simulate session expiry → voter re-authenticates → voter submits motion 1 + motion 2 → verify motion 1 is not duplicated, motion 2 is added, total vote count correct
- [x] The test uses the real test DB, not mocks
- [x] All new tests pass

**Technical notes:** `backend/tests/test_phase2_api.py`.

**Priority:** P1 | **Effort:** M

---

### RR3-31: Duplicate lot number import error must include row-level detail

**As an** admin importing lot owners,
**I want** the 422 error for duplicate lot numbers to name the specific lot numbers and rows that conflict,
**So that** I can fix the import file without manually hunting for duplicates.

**Acceptance criteria:**
- [x] `import_lot_owners()` 422 response body lists each duplicate lot number and the rows it appeared on: e.g., `"Lot 42 appears on rows 3 and 7"`
- [x] Existing integration test for duplicate lots is updated to assert the detail message contains the lot number
- [x] Response format matches the existing error array pattern in `admin_service.py`

**Technical notes:** `backend/app/services/admin_service.py` — lot owner import validation.

**Priority:** P1 | **Effort:** S

---

### RR3-32: Email delivery assertion missing from no-lot-weights close test

**As a** QA engineer,
**I want** the meeting-close-with-no-lot-weights test to assert email delivery is triggered,
**So that** a regression where email is skipped on an empty meeting is caught automatically.

**Acceptance criteria:**
- [x] `test_close_agm_with_no_lot_weights_no_absent_records` adds: query `EmailDelivery` for the meeting after close → assert exactly one row exists with `status` in (`pending`, `sent`)
- [x] The test passes on the current codebase

**Technical notes:** `backend/tests/test_admin_meetings_api.py:2864`.

**Priority:** P1 | **Effort:** S

---

## 11. Review Round 3 — Medium Findings

Medium-priority issues are grouped by theme. All are P1 or P2.

---

### RR3-33: Rate limiting gaps on ballot submission and public endpoints

**As a** system operator,
**I want** rate limits on the ballot submission and public list endpoints,
**So that** a flood of requests cannot exhaust the DB connection pool or enumerate all meetings.

**Acceptance criteria:**
- [x] `POST /api/agm/{id}/submit` is rate-limited per session (e.g., 5 requests per minute per `voter_email`) — returns 429 on excess
- [x] `GET /api/buildings`, `GET /api/general-meeting/{id}/summary` are rate-limited per IP (e.g., 60 requests per minute) — returns 429 on excess
- [x] Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`) are included in 429 responses
- [x] A unit test verifies 429 is returned on the N+1th request within the window

**Technical notes:** `backend/app/routers/voting.py`, `backend/app/routers/public.py`. Use `slowapi` or a custom middleware.

**Priority:** P1 | **Effort:** M

---

### RR3-34: File upload size limits and debug endpoint access controls

**As a** system operator,
**I want** import endpoints to reject oversized files and debug endpoints to be harder to access,
**So that** a malicious or accidental large upload cannot exhaust Lambda memory and operational details are not freely visible.

**Acceptance criteria:**
- [x] All `UploadFile` endpoints (`buildings/import`, `lot-owners/import`, `import-proxies`, `import-financial-positions`) reject files over 5 MB with 413 before reading the content
- [x] Debug endpoints (`/debug/meeting-status`, `/debug/email-deliveries`, `/debug/db-health`) require a `testing_mode=True` check or a separate `X-Debug-Key` header in addition to admin auth
- [x] `/debug/email-deliveries` adds `limit: int = 100` query parameter (default 100, max 500)

**Technical notes:** `backend/app/routers/admin.py:149,745`.

**Priority:** P2 | **Effort:** S

---

### RR3-35: Weak startup defaults must be rejected in non-development environments

**As a** security engineer,
**I want** the application to refuse to start if default secrets are in use outside development,
**So that** a misconfigured production deploy is caught before it accepts real traffic.

**Acceptance criteria:**
- [x] `config.py` startup validator raises `ValueError` if `session_secret == "change_me_to_a_random_secret"` and `environment != "development"`
- [x] Same check applies to `admin_password == "admin"` or any value that does not start with `$2b$` or `$2a$` (complementing RR3-17)
- [x] Preview deployments (`environment == "preview"`) are treated as non-development and are subject to the same checks
- [x] Session middleware on preview sets `https_only=True` — the current `environment == "production"` guard is widened to `environment != "development"`

**Technical notes:** `backend/app/config.py:22-24`, `backend/app/main.py:66-71`.

**Priority:** P1 | **Effort:** S

---

### RR3-36: Session and token duration hardening

**As a** backend developer,
**I want** session and token duration constants to be aligned and the unused one removed,
**So that** a future developer is not misled into thinking sessions last 24 hours.

**Acceptance criteria:**
- [x] `SESSION_DURATION_HOURS = 24` constant is removed from `auth_service.py`
- [x] `_TOKEN_MAX_AGE_SECONDS` is set to `int(SESSION_DURATION.total_seconds())` (1800) — token signature cannot outlive the DB session
- [x] The voter session cookie `SameSite` is changed from `strict` to `lax` so the cookie is sent on first navigation from the OTP email link — `auth.py:421`
- [x] A unit test verifies the token max age matches the session duration

**Technical notes:** `backend/app/services/auth_service.py:16-22`, `backend/app/routers/auth.py:421`.

**Priority:** P1 | **Effort:** S

---

### RR3-37: Backend data quality fixes

**Status: ✅ Implemented**

**As a** backend developer,
**I want** several small correctness issues fixed,
**So that** edge cases in datetime handling, import validation, and multi-choice voting are handled explicitly.

**Acceptance criteria:**
- [ ] `get_effective_status()` in `general_meeting.py:41` replaces the silent UTC assumption with an assertion: `assert starts_at.tzinfo is not None, "Naive datetime from DB — check timezone=True column"` — lets real bugs surface rather than masking them
- [ ] `import_lot_owners()` (and other import functions) wrap error arrays in `{"errors": errors}` dict rather than returning a bare list — consistent with FastAPI's standard `detail` format
- [ ] Multi-choice option submission validates that selected option IDs contain no duplicates; returns 422 "Duplicate option IDs" if they do; `voting_service.py:280`

**Technical notes:** `backend/app/models/general_meeting.py:41`, `backend/app/services/admin_service.py:106`, `backend/app/services/voting_service.py:280`.

**Priority:** P2 | **Effort:** S

---

### RR3-38: SRE observability improvements

**Status: ✅ Implemented**

**As a** system operator,
**I want** several small observability gaps closed,
**So that** operational issues are surfaced earlier and incidents are faster to diagnose.

**Acceptance criteria:**
- [ ] `GET /api/health` response includes `"version"` (git SHA or build timestamp from env var `VERCEL_GIT_COMMIT_SHA`) and `"migrations_current"` (result of `SELECT version_num FROM alembic_version`)
- [ ] OTP email send (`email_service.send_otp_email`) retries up to 3 times with 1s/2s/4s backoff on SMTP failure before raising
- [ ] Email retry max attempts and backoff cap are configurable via `EMAIL_RETRY_MAX_ATTEMPTS` and `EMAIL_BACKOFF_CAP_SECONDS` env vars (defaults: 30 and 3600)
- [ ] `docs/slo.md` is updated to specify the chosen metrics/alerting approach and links to the alert configuration
- [ ] `docs/runbooks/database-connectivity.md` documents the three capacity scaling options (Neon plan upgrade, pool size increase, PgBouncer)
- [ ] CSP `unsafe-inline` is tracked as a known issue with a comment: "Required for Vite module preload polyfill — revisit when Vite 5.x supports nonce-based CSP"

**Technical notes:** `backend/app/main.py:90-106`, `backend/app/services/email_service.py:42,75`, `docs/slo.md`, `docs/runbooks/database-connectivity.md`.

**Priority:** P1 | **Effort:** M

---

### RR3-39: Accessibility medium fixes — voter UI

**Status: ✅ Implemented**

**As a** voter using assistive technology,
**I want** several small accessibility issues fixed in the voting UI,
**So that** the experience is consistent and WCAG 2.1 AA compliant throughout.

**Acceptance criteria:**
- [ ] `CountdownTimer.tsx` changes `aria-live="polite"` to `aria-live="off"` on the per-second ticker; adds a separate `aria-live="assertive"` announcement-only element that fires only when the timer enters the 5-minute warning state
- [ ] Sidebar drawer (`VotingPage.tsx:597`) gains a `keydown` handler: Escape closes the drawer and returns focus to the trigger button
- [ ] Sidebar drawer close button (`VotingPage.tsx:610`) removes the `✕` character and relies solely on `aria-label="Close lot selector"`
- [ ] Motion card unanswered/voted badges (`MotionCard.tsx:65`) gain `role="status"` so their text is announced when they first appear
- [ ] `AuthForm.tsx` required-field hint replaces `<span aria-hidden="true">*</span> Required field` with simply `Required field` (asterisk is redundant given the text)
- [ ] All modified components pass existing unit tests; verify in browser using dev-browser skill

**Technical notes:** `frontend/src/components/vote/CountdownTimer.tsx:36`, `frontend/src/pages/vote/VotingPage.tsx:549,597,610`, `frontend/src/components/vote/MotionCard.tsx:65`, `frontend/src/components/vote/AuthForm.tsx:81`.

**Priority:** P1 | **Effort:** M

---

### RR3-40: Frontend medium fixes — error handling, loading states, and modal UX

**Status: ✅ Implemented**

**As a** user of the admin portal and voter UI,
**I want** several small UX and correctness issues fixed,
**So that** errors are handled gracefully and the interface behaves predictably.

**Acceptance criteria:**
- [ ] `BuildingDetailPage.tsx:307` — modal is hidden in a `finally` block so it closes whether the async operation succeeds or fails, preventing a stuck open modal on error
- [ ] API error messages displayed to the user are truncated to 200 characters maximum to prevent raw stack traces rendering in the UI
- [ ] Building selection dropdown shows a spinner or disabled state while the buildings query is loading (`BuildingSelectPage.tsx:81`)
- [ ] `AuthVerifyResponse` TypeScript type removes or marks `session_token` as optional/deprecated — it is not used by the frontend
- [ ] Lot selection validation error (e.g., "no lots selected") is wrapped in an `aria-live="assertive"` region so screen readers announce it immediately

**Technical notes:** `frontend/src/pages/admin/BuildingDetailPage.tsx:307,386`, `frontend/src/pages/vote/BuildingSelectPage.tsx:81`, `frontend/src/api/`.

**Priority:** P2 | **Effort:** M

---

### RR3-41: QA medium coverage gaps

**Status: ✅ Implemented**

**As a** QA engineer,
**I want** several missing test scenarios added,
**So that** edge cases in the voting, draft, and import flows are verified automatically.

**Acceptance criteria:**
- [ ] E2E test: voter starts voting, session expires (mock server returns 401), voter re-authenticates, voting continues from saved state — asserts no data loss
- [ ] E2E test: multi-lot voter drafts votes for lot A, switches to lot B, submits lot B, revisits lot A — asserts lot A drafts are still present
- [ ] Integration test: `POST /api/agm/{id}/submit` with a request body that is valid JSON but missing `lot_owner_ids` returns 422
- [ ] Integration test: import lot owner CSV → update lot to `in_arrear` via financial position import → create AGM → voter submits → assert General Motion vote for that lot is `not_eligible`
- [ ] Playwright selector audit: all `page.locator(".some-class")` calls in E2E specs are replaced with role-based or `data-testid` selectors; `data-testid` attributes are added to key interactive elements
- [ ] E2E timeouts standardised: all `{ timeout: N }` overrides use `process.env.CI ? 30000 : 15000`

**Technical notes:** `frontend/e2e/`, `backend/tests/test_phase2_api.py`, `backend/tests/test_admin_lot_owners_api.py`.

**Priority:** P1 | **Effort:** L

---

## 12. Review Round 3 — Low Findings

Low-priority issues are grouped into thematic cleanup stories. All are P2.

---

### RR3-42: Backend observability and code hygiene cleanup

**Status: ✅ Implemented**

**As a** backend developer,
**I want** a batch of small backend hygiene issues resolved,
**So that** the codebase is easier to maintain and observe in production.

**Acceptance criteria:**
- [ ] Remove unused constant `SESSION_DURATION_HOURS = 24` (covered by RR3-36 but listed here for tracking)
- [ ] Add request correlation ID middleware: generate `X-Request-ID = uuid4()` in `SecurityHeadersMiddleware`, bind to `structlog` context, include in all log events and response headers
- [ ] Add SQLAlchemy event listener logging queries > 200 ms: `event=slow_query`, `duration_ms`, `query_hash` (first 8 chars of MD5)
- [ ] Make email retry config env-var driven: `EMAIL_RETRY_MAX_ATTEMPTS` (default 30), `EMAIL_BACKOFF_CAP_SECONDS` (default 3600)
- [ ] Remove `python-json-logger` from `pyproject.toml` (unused — structlog is the logger)
- [ ] Add `pip-audit` to dev dependencies and CI pipeline; fail build on HIGH/CRITICAL CVEs
- [ ] Add `admin.py` debug email-deliveries endpoint `limit` query param (default 100, max 500) to prevent unbounded result sets
- [ ] Add OTP rate-limit window fix: `first_attempt_at` is set only on the first OTP issue in a window, not reset on subsequent issues — `auth.py:167`
- [ ] Add DB query timeout at pool level: `connect_args={"statement_timeout": "5000"}` so hung queries fail after 5 s rather than indefinitely

**Technical notes:** `backend/app/main.py`, `backend/app/services/auth_service.py`, `backend/app/services/email_service.py`, `backend/app/routers/admin.py`, `backend/pyproject.toml`, `.github/workflows/ci.yml`.

**Priority:** P2 | **Effort:** M

---

### RR3-43: Non-DB data backup strategy

**Status: ✅ Implemented**

**As a** system operator,
**I want** a documented backup strategy for any non-database data (uploaded files),
**So that** the disaster recovery plan covers all data stores.

**Acceptance criteria:**
- [ ] `docs/runbooks/disaster-recovery.md` is updated with a "File Storage" section noting: if import files are ephemeral (Lambda `/tmp`), they are not backed up (acceptable — source files are re-uploadable); if any persistent file storage is used, its backup strategy is documented
- [ ] `CLAUDE.md` is updated if any new persistent storage is introduced in future features

**Technical notes:** `docs/runbooks/disaster-recovery.md`.

**Priority:** P2 | **Effort:** S

---

### RR3-44: Accessibility low-priority polish

**Status: ✅ Implemented**

**As a** voter or admin using assistive technology,
**I want** several small accessibility polish items addressed,
**So that** the app is as inclusive as possible for users of all abilities.

**Acceptance criteria:**
- [ ] Primary button colour combination (`--gold-light` on `--color-primary`) is verified with a contrast checker; if < 4.5:1 the gold is lightened to pass — document the ratio in a CSS comment
- [ ] All admin `<table>` elements gain `aria-label` or `aria-labelledby` pointing to their section heading
- [ ] Each page is audited to confirm exactly one `<main>` element exists — fix any accidental nesting
- [ ] `Pagination.tsx` is reviewed against US-ACC requirements: `aria-label="Page N"` on each button, `aria-current="page"` on active, `aria-label="Previous page"` / `"Next page"` on nav buttons

**Technical notes:** `frontend/src/styles/index.css:276`, `frontend/src/components/admin/*Table.tsx`, all page components, `frontend/src/components/admin/Pagination.tsx`.

**Priority:** P2 | **Effort:** M

---

### RR3-45: Frontend low-priority code quality

**Status: ✅ Implemented**

**As a** frontend developer,
**I want** a set of small code quality issues resolved,
**So that** the codebase is clean and consistent.

**Acceptance criteria:**
- [ ] Remove unused React import from `LotOwnerForm.tsx:1` (React 17+ JSX transform does not require it)
- [ ] Replace `value as SomeType` type cast in `ConfirmationPage.tsx:44` with an `instanceof` check or a proper type guard
- [ ] Remaining inline `style` colour and spacing values in `ConfirmationPage.tsx` are extracted to CSS classes (per design system rule against inline style props for colours/spacing)

**Technical notes:** `frontend/src/components/admin/LotOwnerForm.tsx:1`, `frontend/src/pages/vote/ConfirmationPage.tsx:44`.

**Priority:** P2 | **Effort:** S

---

### RR3-46: QA low-priority test additions

**Status: ✅ Implemented**

**As a** QA engineer,
**I want** a small set of missing test scenarios added,
**So that** no obvious regression path is left uncovered.

**Acceptance criteria:**
- [ ] Integration test: create motion with `motion_number="1"` → attempt to update to `motion_number="2"` (if update is supported) → verify the number is rejected or unchanged (immutability after creation)
- [ ] Integration test: `EmailDelivery` status transitions are exercised — `pending → sent`, `pending → failed` — verifying the full lifecycle is reachable in tests
- [ ] All new tests pass at 100% coverage

**Technical notes:** `backend/tests/test_admin_meetings_api.py`, `backend/tests/` — email delivery tests.

**Priority:** P2 | **Effort:** S

---

## 13. User-Reported Bugs

---

### RR3-47: Hidden motions must not record abstain votes for voters who never saw them

**Status:** 🔄 In progress — branch: `fix/hidden-motion-vote-recording`

**As a** meeting organiser,
**I want** voters who submitted while a motion was hidden to show as "not voted" on that motion — not "abstained",
**So that** the tally accurately reflects that the voter was never given the opportunity to vote on that motion.

**Background:** When a voter submits their ballot, unanswered visible motions are currently recorded as `abstain`. If a motion is hidden at submission time and the voter therefore never sees it, the same `abstain` record is incorrectly created. The voter can still vote once the motion is made visible (the system allows this), so the false abstain record is a data accuracy issue that corrects itself when the voter re-votes — but in the interim the tally is misleading.

**Acceptance criteria:**
- [ ] `voting_service.submit_ballot()` does not create `abstain` (or `not_eligible`) vote records for motions where `Motion.is_visible == False` at submission time
- [ ] If a motion is later made visible and the voter re-submits, a vote record is created at that point — this already works; confirm it is not broken by the fix
- [ ] Admin meeting report shows voters who submitted while a motion was hidden as "no vote" / absent for that motion, not "abstained"
- [ ] Integration test: create meeting with visible motion A and hidden motion B → voter submits answering motion A → assert no Vote row exists for motion B for this voter → make motion B visible → voter re-submits answering motion B → assert Vote row now exists for motion B
- [ ] All existing ballot submission tests pass

**Technical notes:** `backend/app/services/voting_service.py` — `submit_ballot()` — the section that creates `abstain` records for unanswered motions; add `.where(Motion.is_visible == True)` to the query that determines which unanswered motions to record.

**Status:** ✅ Implemented — branch: `fix/rr3-47-rr3-48`, committed 2026-03-31

**Priority:** P1 | **Effort:** S

---

### RR3-48: Multi-choice motions must display their legal type (General/Special), not their voting mechanism

**Status:** 🔄 In progress — branch: `fix/hidden-motion-vote-recording`

**As a** meeting organiser,
**I want** the admin meeting page to show "General" or "Special" as the motion type for multi-choice motions,
**So that** it is clear which legal threshold applies — multi-choice is a voting mechanism, not a motion type.

**Background:** Multi-choice is how voters cast their vote (selecting multiple options), not what legal category the motion falls under. The motion type (`motion_type` field: `general` or `special`) determines the statutory threshold. Displaying "Multi-choice" as the type conflates the two concepts and could cause confusion about whether a special resolution threshold applies.

**Acceptance criteria:**
- [ ] On the admin meeting detail/report page, the type badge/label for a multi-choice motion shows `General` or `Special` based on `motion.motion_type` — not a "Multi-choice" label
- [ ] A separate, smaller indicator (e.g., a secondary badge or icon) may be used to show that the voting mechanism is multi-choice, but it must be visually distinct from the type label and not replace it
- [ ] Verify in browser using dev-browser skill: a meeting with both a General multi-choice motion and a Special single-choice motion correctly displays "General" and "Special" respectively

**Technical notes:** `frontend/src/` — wherever `MotionTypeBadge` or similar component renders the motion type label; the fix is to always source the displayed type from `motion.motion_type` (general/special) rather than from a derived `is_multi_choice` flag.

**Status:** ✅ Implemented — branch: `fix/rr3-47-rr3-48`, committed 2026-03-31

**Priority:** P1 | **Effort:** S

---

## Priority Summary

| Theme | P0 | P1 | P2 | Total | Done |
|-------|----|----|-----|-------|------|
| Vote Integrity & Legal Compliance | 2 | 4 | 2 | 8 | 0 |
| Identity & Authentication Security | 3 | 1 | 0 | 5 | 0 |
| Operational Readiness | 1 | 4 | 3 | 8 | 0 |
| Accessibility & Usability | 0 | 5 | 3 | 8 | 0 |
| Performance & Scalability | 0 | 2 | 0 | 2 | 0 |
| Code Quality & Maintainability | 0 | 1 | 5 | 6 | 3 |
| Test Coverage Gaps | 2 | 3 | 1 | 6 | 0 |
| Review Round 2 — New Findings | 3 | 4 | 1 | 8 | 0 |
| Review Round 3 — Critical (RR3-01–10) | 10 | 0 | 0 | 10 | 0 |
| Review Round 3 — High (RR3-11–32) | 10 | 12 | 0 | 22 | 0 |
| Review Round 3 — Medium (RR3-33–41) | 0 | 6 | 3 | 9 | 0 |
| Review Round 3 — Low (RR3-42–46) | 0 | 0 | 5 | 5 | 0 |
| **Totals** | **31** | **42** | **23** | **97** | **3** |

> Round 3 adds 46 new stories (RR3-01 through RR3-46) covering all critical, high, medium, and low findings from the second 8-perspective team review.
>
> Already covered by earlier stories: H-7 CSRF (US-IAS-05), H-15 smoke tests (US-OPS-03), H-17 email escalation (US-OPS-05), H-18 DR drill (US-OPS-06), H-20 alerting (RR3-08), H-23 MixedSelection Escape (US-ACC-02), H-25 BuildingEditModal focus (RR3-07), H-27 modal inconsistency (RR3-07), H-31 aria-describedby (US-ACC-05), H-33 E2E isolation (US-TCG-05). C-1 covered by US-IAS-04. C-6 accepted per US-VIL-02. Runtime bugs C-2/C-7/C-8/C-9 are in `tasks/design/design-critical-runtime-bugs.md`.

---

## Round 4 Review Findings

These user stories capture bugs and improvements surfaced by the fourth engineering review pass. Items cover security, data integrity, performance, accessibility, and code quality issues across backend and frontend.

---

### RR4-02: Hidden motions exposed on public summary endpoint

**As a** meeting organiser,
**I want** `GET /api/general-meeting/{id}/summary` to exclude motions with `is_visible=False`,
**So that** draft motion text is never disclosed to the public before the organiser makes it visible.

**Acceptance criteria:**
- [ ] The query in `public.py:124` adds `.where(Motion.is_visible == True)` before returning motions
- [ ] An integration test verifies: create meeting with one visible and one hidden motion → call the public summary endpoint → only the visible motion appears in the response
- [ ] A closed meeting may return all motions regardless of visibility (confirm with product); document the decision in a code comment

**Technical notes:** `backend/app/routers/public.py:124` — missing `is_visible` filter. Duplicate of RR3-14 scope but confirmed still present in current codebase.

**Priority:** P0 | **Effort:** S

---

### RR4-03: `VoteChoice.against` silently misclassified as abstained in General/Special motion tallies

**As a** meeting auditor,
**I want** votes cast as `VoteChoice.against` to appear in the "Against" tally column,
**So that** the reported vote counts are accurate and legally defensible.

**Acceptance criteria:**
- [ ] `admin_service.py:1596` — the tally computation for General/Special motions correctly maps `VoteChoice.against` to the `no` bucket, not the `abstained` bucket
- [ ] An integration test creates a meeting with a General motion, submits one `against` vote, and asserts `tally.no.voter_count == 1` and `tally.abstained.voter_count == 0`
- [ ] All existing tally tests pass

**Technical notes:** `backend/app/services/admin_service.py:1596`. `VoteChoice.against` enum value (used in admin vote entry) must map to the same tally bucket as `VoteChoice.no`.

**Priority:** P0 | **Effort:** S

---

### RR4-04: `compute_multi_choice_outcomes` called before `db.commit()` — outcomes lost on exception

**As a** meeting organiser,
**I want** multi-choice outcome computation to be durable even if the surrounding transaction fails,
**So that** pass/fail outcomes are always persisted correctly after meeting close.

**Acceptance criteria:**
- [ ] `admin_service.py:2203` — `compute_multi_choice_outcomes` is called and awaited only after `db.commit()` has succeeded for the ballot data
- [ ] A unit test simulates a commit failure after outcome computation and verifies the outcome is not partially written
- [ ] All existing close-meeting tests pass

**Technical notes:** `backend/app/services/admin_service.py:2203` — re-order the commit and outcome computation calls.

**Priority:** P0 | **Effort:** S

---

### RR4-05: `enter_votes_for_meeting` `IntegrityError` handler rolls back entire session, losing all previously flushed lots

**As an** admin entering in-person votes,
**I want** a duplicate vote error for one lot to not discard successfully entered votes for other lots in the same batch,
**So that** a partial conflict does not require re-entering all votes.

**Acceptance criteria:**
- [ ] `admin_service.py:3389` — the `IntegrityError` handler uses a savepoint or per-lot subtransaction so only the conflicting lot's votes are rolled back; successfully flushed lots are retained
- [ ] An integration test enters votes for lots A, B, C where B already has a submission; asserts lots A and C are recorded and only B raises 409
- [ ] All existing admin vote entry tests pass

**Technical notes:** `backend/app/services/admin_service.py:3389`. Use `db.begin_nested()` savepoints around each lot's flush.

**Priority:** P0 | **Effort:** M

---

### RR4-06: `compute_multi_choice_outcomes` loads ALL votes into memory — O(V×M×O) performance issue

**As a** system operator,
**I want** multi-choice outcome computation to use efficient DB-side aggregation,
**So that** closing a meeting with many votes does not exhaust Lambda memory.

**Acceptance criteria:**
- [ ] `admin_service.py:2277` — replace the Python-side vote loading loop with a SQL `GROUP BY` aggregate query that counts `selected` votes per option directly in the DB
- [ ] The new implementation is O(1) in memory regardless of vote count
- [ ] An integration test with 100+ votes verifies the outcome computation completes in < 500 ms

**Technical notes:** `backend/app/services/admin_service.py:2277`. Use `func.count()` with `GROUP BY motion_option_id` in a single query.

**Priority:** P0 | **Effort:** M

---

### RR4-07: Migration chain has branching — Alembic versions may apply out of order

**As a** developer,
**I want** the Alembic migration chain to have a single unambiguous head,
**So that** `alembic upgrade head` always applies migrations in the correct deterministic order.

**Acceptance criteria:**
- [ ] `alembic/versions/` contains no branching revisions (i.e., `alembic heads` returns exactly one head)
- [ ] If multiple heads exist, a merge migration is created: `alembic merge heads -m "merge migration branches"`
- [ ] CI `alembic upgrade head` run on a clean DB succeeds without errors or warnings about multiple heads
- [ ] All existing migration tests pass

**Technical notes:** `backend/alembic/versions/`. Run `alembic heads` to check; if > 1 result, create a merge revision.

**Priority:** P0 | **Effort:** S

---

### RR4-08: Email trigger uses request-scoped `BackgroundTasks` — silent drop on Lambda exit

**As a** meeting organiser,
**I want** the results email to be reliably triggered even if the Lambda exits immediately after the close API response,
**So that** no meeting close silently loses its email notification.

**Acceptance criteria:**
- [ ] `admin.py:651` — the email trigger is moved out of `BackgroundTasks` and into an `asyncio.create_task()` or persisted via the `EmailDelivery` record + cron retry (per RR3-19 pattern), so the request lifecycle does not gate the send
- [ ] A unit test verifies the `EmailDelivery` record is created with `status=pending` synchronously before the HTTP response returns, ensuring the cron retry can pick it up even if the background task is dropped
- [ ] All existing email delivery tests pass

**Technical notes:** `backend/app/routers/admin.py:651`. The `EmailDelivery` record creation must be committed within the main request transaction; the actual send is best-effort and cron-backed.

**Priority:** P0 | **Effort:** M

---

### RR4-09: Race condition — `voting_closed_at` checked before `SELECT FOR UPDATE`

**As a** voter,
**I want** the ballot submission endpoint to atomically check voting status and lock the submission record,
**So that** a vote cannot slip through between the status check and the lock acquisition.

**Acceptance criteria:**
- [ ] `voting_service.py:333` — the `voting_closed_at` check is moved inside the `SELECT FOR UPDATE` transaction, not before it
- [ ] An integration test simulates a concurrent submission where the meeting closes between the status check and the lock; asserts the second submission receives 403
- [ ] All existing submission tests pass

**Technical notes:** `backend/app/services/voting_service.py:333`.

**Priority:** P1 | **Effort:** S

---

### RR4-10: `get_general_meeting_detail` has O(V×M) Python filtering per motion

**As a** system operator,
**I want** the meeting detail endpoint to aggregate vote tallies in the DB,
**So that** a meeting with many voters and motions does not cause a slow admin report page.

**Acceptance criteria:**
- [ ] `admin_service.py:1504` — the per-motion voter-list filtering is replaced with a SQL `GROUP BY` query or a pre-loaded dictionary keyed by `(motion_id, choice)`
- [ ] The number of Python iterations over the vote list is O(M) not O(V×M)
- [ ] An integration test with 50 voters × 10 motions verifies the endpoint responds in < 500 ms

**Technical notes:** `backend/app/services/admin_service.py:1504`.

**Priority:** P1 | **Effort:** M

---

### RR4-11: Admin vote entry grid full re-render on every cell change

**As an** admin entering in-person votes,
**I want** clicking a vote button to only re-render the affected cell, not the entire vote grid,
**So that** entering votes for many lots stays responsive.

**Acceptance criteria:**
- [ ] `AdminVoteEntryPanel.tsx:153` — `setLotVotes` state update no longer causes all lot columns to re-render; use `React.memo` on the per-lot cell component or split state so only the affected lot re-renders
- [ ] A Vitest unit test with 10 lots × 10 motions verifies that clicking one vote button causes exactly one cell component to re-render (use `renderCount` or spy)
- [ ] All existing admin vote entry tests pass

**Technical notes:** `frontend/src/pages/admin/AdminVoteEntryPanel.tsx:153`.

**Priority:** P1 | **Effort:** M

---

### RR4-12: Duplicate `option_id` in `option_choices` causes misleading 409 instead of validation error

**As an** admin or voter,
**I want** submitting duplicate option IDs in a multi-choice vote to return 422,
**So that** client bugs are reported as input validation errors, not server conflicts.

**Acceptance criteria:**
- [ ] `voting_service.py:453` — before inserting votes, validate that `option_ids` contains no duplicates; return 422 "Duplicate option IDs in submission" if duplicates are found
- [ ] Unit test verifies 422 is returned for `option_ids: ["A", "A"]`
- [ ] All existing multi-choice submission tests pass

**Technical notes:** `backend/app/services/voting_service.py:453`. This complements RR3-37 which added duplicate validation for the import path.

**Priority:** P1 | **Effort:** S

---

### RR4-13: `multiChoiceSelections` never persisted to `sessionStorage` — page refresh loses all multi-choice votes

**As a** voter,
**I want** my multi-choice vote selections to survive a page refresh,
**So that** an accidental refresh does not lose my in-progress selections.

**Acceptance criteria:**
- [ ] `VotingPage.tsx:42` (or wherever session storage persistence is initialised) — `multiChoiceSelections` is included in the serialised session storage state alongside binary motion choices
- [ ] After a page refresh, `multiChoiceSelections` for all lots are restored from session storage
- [ ] A Vitest unit test verifies that `multiChoiceSelections` is written to and read from `sessionStorage` correctly
- [ ] All existing voting flow tests pass

**Technical notes:** `frontend/src/pages/vote/VotingPage.tsx:42`.

**Priority:** P1 | **Effort:** S

---

### RR4-14: QR code modal lacks focus trap and initial focus management

**As an** admin using keyboard navigation,
**I want** the QR code modal to trap focus and move focus to the first focusable element on open,
**So that** keyboard navigation is consistent across all admin modals.

**Acceptance criteria:**
- [ ] `AgmQrCodeModal.tsx` implements the same focus trap pattern as other admin modals (per US-ACC-02 / RR3-07)
- [ ] When the modal opens, focus moves to the close button or the first focusable element inside
- [ ] Tab and Shift+Tab cycle within the modal
- [ ] Pressing Escape closes the modal and returns focus to the trigger button
- [ ] A unit test verifies focus is moved inside the modal on open

**Technical notes:** `frontend/src/components/admin/AgmQrCodeModal.tsx`.

**Priority:** P1 | **Effort:** S

---

### RR4-15: `AdminVoteEntryPanel` `ConfirmDialog` has no focus trap

**As an** admin using keyboard navigation,
**I want** the vote entry confirmation dialog to trap focus,
**So that** pressing Tab cannot escape the dialog to the page behind it.

**Acceptance criteria:**
- [ ] `AdminVoteEntryPanel.tsx:50` — `ConfirmDialog` implements a focus trap (same pattern as US-ACC-02)
- [ ] On open, focus moves to the Cancel button (safer default for a destructive confirmation)
- [ ] Tab cycles within the dialog; Escape closes it
- [ ] A unit test verifies focus behaviour

**Technical notes:** `frontend/src/pages/admin/AdminVoteEntryPanel.tsx:50`.

**Priority:** P1 | **Effort:** S

---

### RR4-16: Migration head mismatch logs CRITICAL but does not halt Lambda startup

**As a** system operator,
**I want** a migration head mismatch to prevent the Lambda from serving requests,
**So that** a failed migration does not silently serve requests against a stale schema.

**Acceptance criteria:**
- [ ] `main.py:176` — when `_check_migration_head()` detects a mismatch it raises `RuntimeError` (or sets a flag that causes all routes to return 503) rather than only logging CRITICAL and continuing
- [ ] A unit test verifies the Lambda does not process requests when a mismatch is detected
- [ ] All existing startup tests pass

**Technical notes:** `backend/app/main.py:176`. Complements RR3-20.

**Priority:** P1 | **Effort:** S

---

### RR4-17: In-memory rate limiter not shared across Lambda instances

**As a** security engineer,
**I want** the OTP and admin rate limiter to use a shared DB-backed store,
**So that** brute-force attempts across multiple Lambda cold starts are correctly rate-limited.

**Acceptance criteria:**
- [ ] `rate_limiter.py:25` — the in-memory rate limit counter is replaced with a DB-backed counter (using the existing `OtpRateLimit` or `AdminLoginAttempt` table) or an external store (Redis/Upstash)
- [ ] An integration test verifies that the rate limit is enforced when the same IP makes requests that would be spread across fresh in-memory stores
- [ ] All existing rate limit tests pass

**Technical notes:** `backend/app/services/rate_limiter.py:25`. The OTP rate limit already uses `OtpRateLimit` (DB-backed); audit whether any remaining in-memory limiter exists.

**Priority:** P1 | **Effort:** M

---

### RR4-18: Admin vote entry table headers missing `scope="col"`

**As an** admin using a screen reader,
**I want** the vote entry table headers to have `scope="col"`,
**So that** the screen reader correctly associates each header with its column of cells.

**Acceptance criteria:**
- [ ] `AdminVoteEntryPanel.tsx:436` — all `<th>` elements in the vote grid `<thead>` have `scope="col"`
- [ ] A unit test verifies the rendered table headers have the `scope` attribute

**Technical notes:** `frontend/src/pages/admin/AdminVoteEntryPanel.tsx:436`.

**Priority:** P1 | **Effort:** S

---

### RR4-19: `canvasRef` cast removes null safety — download silently fails

**As an** admin,
**I want** the QR code download button to always work or show a clear error,
**So that** a null canvas reference does not silently produce no download.

**Acceptance criteria:**
- [ ] `AgmQrCode.tsx:30` — the `canvasRef` null assertion (`!`) is replaced with a proper null check; if the canvas is null, the download handler logs a warning and shows a user-visible error message
- [ ] A unit test verifies the error state is shown when the canvas ref is null

**Technical notes:** `frontend/src/components/admin/AgmQrCode.tsx:30`.

**Priority:** P1 | **Effort:** S

---

### RR4-20: `Vote.motion_option_id` `ondelete="SET NULL"` loses outcome audit trail on option delete

**As a** meeting auditor,
**I want** deleting a motion option to be blocked if votes reference it,
**So that** the vote-to-option relationship is never silently severed.

**Acceptance criteria:**
- [ ] `vote.py:83` — the FK `ondelete` on `motion_option_id` is changed from `SET NULL` to `RESTRICT` via an Alembic migration
- [ ] `DELETE /api/admin/motions/{id}/options/{option_id}` returns 409 if any submitted votes reference the option
- [ ] An integration test verifies the 409 case
- [ ] All existing option management tests pass

**Technical notes:** `backend/app/models/vote.py:83`, `backend/alembic/versions/`. Schema change required.

**Priority:** P1 | **Effort:** M

---

### RR4-21: `close_motion` has no `SELECT FOR UPDATE` — concurrent closes can overwrite timestamp

**As a** meeting organiser,
**I want** concurrent close-motion requests to be serialised,
**So that** only one `voting_closed_at` timestamp is written and the one that "wins" is deterministic.

**Acceptance criteria:**
- [ ] The `close_motion` endpoint handler (or its service function) acquires a `SELECT FOR UPDATE` lock on the `Motion` row before writing `voting_closed_at`
- [ ] An integration test spawns two concurrent close-motion requests and verifies exactly one timestamp is recorded
- [ ] All existing motion management tests pass

**Technical notes:** Admin router close_motion endpoint — add `with_for_update()` to the motion fetch.

**Priority:** P1 | **Effort:** S

---

### RR4-22: `OutcomeBadge` uses inline colour/spacing styles violating design system

**As a** frontend developer,
**I want** `OutcomeBadge` to use CSS class-based styling consistent with the design system,
**So that** colours and spacing are centrally controlled and `grep` checks pass.

**Acceptance criteria:**
- [ ] `AGMReportView.tsx:3` — `OutcomeBadge` inline `style` props for colour, background, font-size, padding, border-radius, and letter-spacing are replaced with CSS modifier classes (e.g., `.outcome-badge--pass`, `.outcome-badge--fail`, `.outcome-badge--tie`) defined in the design system CSS
- [ ] `grep -r "style=" frontend/src/components/admin/AGMReportView.tsx` returns only non-colour/spacing props (e.g., `fontFamily` for monospace tables is acceptable if not in the design system)
- [ ] All existing report view tests pass

**Technical notes:** `frontend/src/components/admin/AGMReportView.tsx:3`. Read `tasks/design/design-system.md` before writing CSS.

**Priority:** P2 | **Effort:** S

---

### RR4-23: `ballot_hash` nullable with no CHECK for non-absent submissions

**As a** meeting auditor,
**I want** every submitted (non-absent) ballot to have a `ballot_hash`,
**So that** tampering with vote records is detectable for all real submissions.

**Acceptance criteria:**
- [ ] `ballot_submission.py:32` — a DB-level `CHECK` constraint is added (or enforced at the service layer) requiring `ballot_hash IS NOT NULL` for `BallotSubmission` rows that are not absent records
- [ ] Existing absent records (where `ballot_hash` is legitimately null) satisfy the constraint
- [ ] An integration test verifies that attempting to insert a non-absent submission without a hash raises a validation error

**Technical notes:** `backend/app/models/ballot_submission.py:32`. May require an Alembic migration for the CHECK constraint.

**Priority:** P2 | **Effort:** S

---

### RR4-24: QR canvas has no `aria-label`/`alt` text — WCAG 1.1.1

**As an** admin using a screen reader,
**I want** the QR code canvas element to have a text alternative,
**So that** assistive technology can convey its purpose to users who cannot see the image.

**Acceptance criteria:**
- [ ] `AgmQrCode.tsx:25` — the `<canvas>` element has `aria-label` (e.g., `aria-label="QR code for [meeting title]"`) or is wrapped in a `<figure>` with a `<figcaption>`
- [ ] A unit test verifies the accessible name is present on the canvas

**Technical notes:** `frontend/src/components/admin/AgmQrCode.tsx:25`.

**Priority:** P2 | **Effort:** S

---

### RR4-25: `LotOwnerForm` error messages lack `role="alert"`

**As an** admin using a screen reader,
**I want** form validation errors to be announced immediately when they appear,
**So that** I do not have to navigate back to find out what went wrong.

**Acceptance criteria:**
- [ ] `LotOwnerForm.tsx:301` — inline field error messages have `role="alert"` (or are wrapped in an `aria-live="assertive"` region) so screen readers announce them without requiring focus
- [ ] A unit test verifies error messages are rendered with `role="alert"`

**Technical notes:** `frontend/src/components/admin/LotOwnerForm.tsx:301`.

**Priority:** P2 | **Effort:** S

---

### RR4-26: Four `except Exception` blocks catch system-level errors instead of specific exceptions

**As a** backend developer,
**I want** exception handlers to catch only the expected exception types,
**So that** unexpected system errors (e.g., `KeyboardInterrupt`, `SystemExit`, memory errors) are not silently swallowed.

**Acceptance criteria:**
- [ ] `admin_service.py:147+` — the four `except Exception` blocks are narrowed to the specific exception types they are designed to handle (e.g., `ValueError`, `IntegrityError`, `openpyxl.exceptions.*`)
- [ ] Any truly unexpected exceptions are re-raised after logging
- [ ] All existing tests pass

**Technical notes:** `backend/app/services/admin_service.py:147` and vicinity.

**Priority:** P2 | **Effort:** S

---

### RR4-27: `submitted_by_admin` stores no admin identity — no audit trail of which admin submitted

**As a** meeting auditor,
**I want** admin-entered ballot submissions to record which admin user submitted them,
**So that** the audit trail identifies the individual responsible, not just a boolean flag.

**Acceptance criteria:**
- [ ] `ballot_submission.py:31` — `submitted_by_admin` boolean is augmented (or replaced) with a `submitted_by_admin_username: str | None` column storing the admin username from the session
- [ ] `enter_votes_for_meeting` in `admin_service.py` populates the admin username on each `BallotSubmission` it creates
- [ ] The admin meeting detail response includes `submitted_by_admin_username` per ballot
- [ ] An Alembic migration adds the new column
- [ ] All existing admin vote entry tests pass

**Technical notes:** `backend/app/models/ballot_submission.py:31`, `backend/app/services/admin_service.py`. Schema change required.

**Priority:** P2 | **Effort:** S

---

### RR4-29: Runbooks missing admin vote entry workflow and per-motion window sections

**As a** system operator,
**I want** the runbooks to cover the admin vote entry and per-motion voting window workflows,
**So that** operators have documented procedures for the full AGM lifecycle.

**Acceptance criteria:**
- [ ] `docs/runbooks/` gains or updates an existing runbook with: steps to use admin vote entry for in-person voters, how to open/close per-motion voting windows, and what to do if admin vote entry fails mid-batch
- [ ] The runbook is linked from `docs/slo.md` or the main runbook index

**Technical notes:** `docs/runbooks/`. No code changes required.

**Priority:** P2 | **Effort:** S

---

### RR4-30: Print CSS injected as inline style in `AgmQrCodeModal` render path

**As a** frontend developer,
**I want** print styles to be defined in the stylesheet rather than injected inline at render time,
**So that** the design system's style isolation rules are respected and inline styles do not leak.

**Acceptance criteria:**
- [ ] `AgmQrCodeModal.tsx:88` — print-specific CSS is moved to a `@media print` block in the component's CSS module or the global stylesheet rather than being injected via a `<style>` tag at render time
- [ ] The print layout (hiding navigation, showing only the QR code) continues to work correctly when the browser print dialog is triggered
- [ ] A unit test verifies the component renders without any inline `<style>` injection

**Technical notes:** `frontend/src/components/admin/AgmQrCodeModal.tsx:88`.

**Priority:** P2 | **Effort:** S

---

### RR4-31: Admin endpoints have no per-endpoint rate limiting beyond login

**As a** security engineer,
**I want** high-volume admin endpoints to have rate limits,
**So that** an authenticated admin (or a stolen session) cannot issue thousands of requests that exhaust the DB pool.

**Acceptance criteria:**
- [ ] Admin import endpoints (`buildings/import`, `lot-owners/import`, `import-proxies`, `import-financial-positions`) are rate-limited to 20 requests per minute per admin session
- [ ] The meeting close endpoint is rate-limited to 10 requests per minute per admin session (prevents accidental double-close loops)
- [ ] 429 responses include `Retry-After` header
- [ ] Unit tests verify 429 is returned on the N+1th request

**Technical notes:** `backend/app/routers/admin.py`. Extend the `slowapi` / rate limiter introduced in RR3-33.

**Priority:** P2 | **Effort:** M

---

### RR4-32: Service shims (`admin_buildings_service.py` etc.) are dead code — not imported anywhere

**As a** backend developer,
**I want** dead code shim files to be removed,
**So that** the codebase is not cluttered with files that are never executed.

**Acceptance criteria:**
- [ ] Any service shim files in `backend/app/services/` that exist solely as re-export proxies and are not imported by any router, test, or other module are deleted
- [ ] `grep -r "admin_buildings_service\|admin_lots_service\|admin_motions_service" backend/` confirms no remaining imports after deletion
- [ ] All tests pass after removal

**Technical notes:** `backend/app/services/admin_buildings_service.py` and similar shims introduced during the US-CQM-02 split.

**Priority:** P2 | **Effort:** S

---

### RR4-33: `voting_closed_at` has no temporal constraint

**As a** meeting organiser,
**I want** a validation error if I try to set `voting_closed_at` to a time before `meeting_at`,
**So that** the voting window cannot accidentally be configured to close before the meeting even starts.

**Acceptance criteria:**
- [ ] `motion.py:69` — a `CHECK` constraint or service-layer validation ensures `voting_closed_at > meeting_at` (or `voting_closes_at > meeting_at` at the meeting level, depending on where the field lives)
- [ ] The relevant creation/update endpoint returns 422 "Voting close time must be after meeting start time" if the constraint is violated
- [ ] A unit test verifies the 422 response

**Technical notes:** `backend/app/models/motion.py:69` or `backend/app/models/general_meeting.py`.

**Priority:** P2 | **Effort:** S

---

### RR4-34: `_check_migration_head` runs on every Lambda cold start adding 200–500 ms

**As a** system operator,
**I want** the migration head check to be cached after the first cold start,
**So that** subsequent Lambda invocations do not incur the DB round-trip cost.

**Acceptance criteria:**
- [ ] `main.py:143` — the result of `_check_migration_head()` is cached in a module-level variable after the first check; subsequent warm invocations skip the DB query
- [ ] The cache is invalidated on Lambda restart (i.e., module re-import), which is the only time it matters
- [ ] A unit test verifies the DB query is not called on a second simulated invocation within the same Lambda instance

**Technical notes:** `backend/app/main.py:143`.

**Priority:** P2 | **Effort:** S

---

### RR4-35: Disabled "For" button has no `aria-describedby` explaining limit reached

**As a** voter using a screen reader,
**I want** a disabled vote button to announce why it is disabled,
**So that** I understand I have reached the option limit without needing to look at the visual counter.

**Acceptance criteria:**
- [ ] `MultiChoiceOptionList.tsx:62` — when a "For" button is disabled due to `option_limit` being reached, the button has `aria-describedby` pointing to a text element that says "Maximum selections reached" (or equivalent)
- [ ] The explanatory text element exists in the DOM when the limit is reached (it can be visually hidden with `sr-only` if already shown visually elsewhere)
- [ ] A unit test verifies the `aria-describedby` is present on disabled buttons

**Technical notes:** `frontend/src/components/vote/MultiChoiceOptionList.tsx:62`.

**Priority:** P2 | **Effort:** S

---

### RR4-36: Optional `given_name`/`surname` fields have no "(optional)" label

**As an** admin filling out the lot owner form,
**I want** optional fields to be labelled "(optional)",
**So that** it is clear I do not have to fill them in to save the record.

**Acceptance criteria:**
- [ ] `LotOwnerForm.tsx:359` — `given_name` and `surname` field labels include "(optional)" text (e.g., "First name (optional)")
- [ ] The "(optional)" text is not `aria-hidden`; screen readers announce it as part of the label
- [ ] A unit test verifies the labels contain the "(optional)" text

**Technical notes:** `frontend/src/components/admin/LotOwnerForm.tsx:359`. Aligns with RR4-25 in the same file.

**Priority:** P2 | **Effort:** S

---

### RR4-37: `<li>` rendered outside `<ul>` in single-lot confirmation path — semantic HTML issue

**As a** voter,
**I want** the confirmation page HTML to be semantically valid,
**So that** assistive technology can correctly interpret the list structure.

**Acceptance criteria:**
- [ ] `ConfirmationPage.tsx:135` — the `<li>` element rendered in the single-lot path is wrapped in a `<ul>` (or `<ol>`) element
- [ ] HTML validation (e.g., via a Vitest test using `axe-core` or HTMLHint) passes for the confirmation page in both single-lot and multi-lot paths
- [ ] All existing confirmation page tests pass

**Technical notes:** `frontend/src/pages/vote/ConfirmationPage.tsx:135`.

**Priority:** P2 | **Effort:** S

---

### RR4-38: `useNavigate()` in `VoteMeetingRedirect` returns new function on every render

**As a** frontend developer,
**I want** `useNavigate()` to be called once per component mount, not on every render,
**So that** unnecessary re-renders caused by a new function reference are avoided.

**Acceptance criteria:**
- [ ] `App.tsx:18` — `useNavigate()` is called at the top level of `VoteMeetingRedirect` (not inside an effect, callback, or conditional), which is the correct React pattern; if the current code already does this, document it as a known false positive; if not, refactor to call it at top level
- [ ] No additional re-renders are caused by the navigate function reference changing
- [ ] A unit test verifies the component does not re-render excessively on stable props

**Technical notes:** `frontend/src/App.tsx:18`.

**Priority:** P2 | **Effort:** S

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
