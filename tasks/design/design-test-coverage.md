# Design: Test Coverage Gaps (US-TCG-01 through US-TCG-06)

**Status:** Implemented

## Overview

This design doc covers the test scenarios added to close coverage gaps identified in the engineering review PRD (`tasks/prd/prd-review-recommendations.md`, section 7 "Test Coverage Gaps"). No schema migrations are required — all changes are pure test additions.

---

## Scope

Six user stories are addressed:

| Story | Area | Type |
|-------|------|------|
| US-TCG-01 | Motion visibility toggle | E2E (backend integration already exists) |
| US-TCG-02 | Concurrent ballot submission race | Backend integration |
| US-TCG-03 | Email failure during meeting close | Backend integration |
| US-TCG-04 | Closed meeting auth flow | E2E |
| US-TCG-05 | Deserialise serial E2E workflows | E2E audit (no change) |
| US-TCG-06 | Hidden motions not in ballot confirmation | E2E |

---

## US-TCG-01: Motion Visibility Toggle

### What it catches

Regressions where hiding/showing a motion silently fails, or where the toggle is
incorrectly allowed on a closed meeting or on a motion that already has votes.

### Backend integration tests (already present)

`backend/tests/test_admin_meetings_api.py` — `TestToggleMotionVisibility` — covers:
- Toggle visible → hidden (no votes) → 200
- Toggle hidden → visible → 200
- Hide visible motion with submitted votes → 409
- Toggle on closed meeting → 409
- Motion not found → 404
- Unauthenticated → 401

These tests already satisfy the acceptance criteria for US-TCG-01's backend story.

### E2E test added

File: `frontend/e2e/admin/admin-general-meetings.spec.ts`

New describe block: **"US-TCG-01: admin hides motion — voter no longer sees it on voting page"**

Scenario:
1. Seed a building with one lot owner and one open meeting containing 2 visible motions.
2. Admin navigates to the meeting detail page.
3. Admin hides motion 2 via the visibility toggle.
4. Voter authenticates via OTP and lands on the voting page.
5. Assert only 1 motion card is visible (motion 2 has been hidden).

This catches a regression where the visibility API succeeds but the voter-facing page
continues to render hidden motions.

---

## US-TCG-02: Concurrent Ballot Submission Race

### What it catches

A race condition where two simultaneous `POST /api/general-meeting/{id}/submit` requests
for the same `(meeting_id, lot_owner_id)` pair both succeed, violating the unique constraint
and creating duplicate `BallotSubmission` rows or double-counting votes.

### Existing unit test

`backend/tests/test_phase2_api.py` — `test_concurrent_submission_integrity_error_raises_409` uses
a fully-mocked `AsyncSession` that raises `IntegrityError` on the third `flush()`. This verifies
the error-handling branch in `voting_service.submit_ballot()` but does not exercise the real
database constraint.

### New integration test added

File: `backend/tests/test_admin_meetings_api.py` — new class `TestConcurrentBallotSubmission`

Uses `asyncio.gather()` to fire 3 concurrent HTTP submissions against the real test database.
Asserts:
- All responses are 200 or 409 (no 500s)
- Exactly 1 `BallotSubmission` row exists in the DB after all 3 complete
- No duplicate `Vote` rows exist for the same `(meeting_id, lot_owner_id, motion_id)`

This catches the case where the unique constraint exists in the schema but the application-level
error handler is missing, or where the constraint is absent from a migration.

Implementation note: the test uses a separate `AsyncClient` per concurrent request (not the
shared `db_session`) so the requests run through the real application stack with separate DB
connections. The test DB is the isolated test database defined in `conftest.py`.

---

## US-TCG-03: Email Failure During Meeting Close

### What it catches

A regression where an exception in the email delivery code rolls back the meeting close
transaction, leaving the meeting open. The correct behaviour is:
1. The meeting closes (DB commit succeeds before email is attempted).
2. An `EmailDelivery` record is created with `status = pending`.
3. The `trigger_with_retry` background task runs independently and catches exceptions
   internally — the close endpoint always returns 200.

### Design of the test

The `close_general_meeting` endpoint creates the `EmailDelivery` record and commits to DB,
then fires `asyncio.create_task(email_service.trigger_with_retry(meeting.id))`. The retry
task uses its own DB session. To test failure without triggering a real SMTP connection,
the test patches `EmailService.send_report` to raise an exception.

The test calls `trigger_with_retry` directly (not via the HTTP endpoint) with a patched
`send_report`, then verifies:
1. The meeting status in the DB is `closed` (unchanged).
2. The `EmailDelivery.status` transitions to `pending` (with `last_error` set) for
   intermediate failures, and `failed` when `total_attempts >= 30`.

A second test verifies `resend_report` transitions a `failed` delivery back to `pending`.

File: `backend/tests/test_admin_meetings_api.py` — new class `TestEmailFailureDuringClose`

---

## US-TCG-04: Closed Meeting Auth Flow (E2E)

### What it catches

The voter auth flow routing when a meeting is already closed. Key scenario from CLAUDE.md:
"Auth on closed AGMs — `POST /api/auth/verify` returns 200 (not 403) for closed AGMs. The
response includes `agm_status: str` so the frontend can route to the confirmation page instead
of blocking entry."

### Scenarios

Two sub-cases are required by the PRD acceptance criteria:
1. **Voter who submitted before close** — authenticates on a closed meeting → routed to
   confirmation page showing their votes.
2. **Voter who did not submit** — authenticates on a closed meeting → routed to confirmation
   page showing "You did not submit a ballot for this meeting."

### Implementation

File: `frontend/e2e/voter/` — new file `closed-meeting-auth.spec.ts`

Uses `test.describe.serial` because the two sub-tests share a single meeting (one voter
submits, one does not; the meeting is closed in beforeAll before the individual tests run).

Seeding:
- Building with 2 lot owners (voter-submitted, voter-absent) and one open meeting.
- `submitBallotViaApi` seeds voter-submitted's ballot in `beforeAll`.
- `closeMeeting` closes the meeting in `beforeAll`.

Tests verify routing after OTP authentication: both voters land on `/vote/{id}/confirmation`.

---

## US-TCG-05: Serial E2E Workflow Audit

### Finding

`frontend/e2e/workflows/voting-scenarios.spec.ts` has 6 `test.describe` blocks, each using
`test.describe.configure({ mode: "serial" })`. Each block has its own independent `beforeAll`
that seeds uniquely-named entities using `RUN_SUFFIX`, so there is no shared state between
blocks at the file level.

**Within each block**, serial mode is genuinely required:
- WF3: sub-tests vote incrementally (WF3.2 votes, WF3.3 votes), then WF3.5-3.6 closes and
  checks tallies. Out-of-order execution would corrupt tally assertions.
- WF4/WF5/WF6/WF7: similar incremental voting or multi-step UI flows.

**Conclusion**: No change is needed. Serial mode within each describe block is correct and
necessary. The describe blocks themselves are independent.

This is documented here to satisfy the audit requirement of US-TCG-05.

---

## US-TCG-06: Hidden Motions Not In Ballot Confirmation (E2E)

### What it catches

A regression where `get_my_ballot` filters by `Motion.is_visible`, so a voter's confirmation
receipt changes after an admin hides a motion post-submission. This violates the legal
requirement that a voter's proof of vote is immutable.

This is related to RR2-08 in the PRD, which specifies the backend fix. This E2E test
verifies the **end-to-end behaviour** from the voter's perspective.

### Scenario

1. Seed a meeting with 2 visible motions and 1 lot owner.
2. Voter votes on both motions and submits.
3. Admin hides motion 2 via the API.
4. Voter re-authenticates (or navigates to confirmation URL directly using session).
5. Assert both motion 1 AND motion 2 appear on the confirmation page.

**Note**: This test will currently FAIL if `get_my_ballot` filters on `is_visible`. The
RR2-08 fix (in a separate branch) is needed for it to pass. The test is added here as a
**failing sentinel** to drive the implementation.

File: `frontend/e2e/voter/` — new file `hidden-motion-confirmation.spec.ts`

---

## No Schema Changes

All changes in this branch are test-only. No Alembic migrations are needed.

---

## Files Changed

### New files
- `frontend/e2e/voter/closed-meeting-auth.spec.ts` — US-TCG-04
- `frontend/e2e/voter/hidden-motion-confirmation.spec.ts` — US-TCG-06

### Modified files
- `backend/tests/test_admin_meetings_api.py` — US-TCG-01 (E2E), US-TCG-02, US-TCG-03 (backend tests added)
- `frontend/e2e/admin/admin-general-meetings.spec.ts` — US-TCG-01 E2E
- `tasks/design/design-test-coverage.md` — this file
