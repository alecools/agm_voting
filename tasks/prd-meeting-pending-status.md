# PRD: Meeting Pending Status

## Introduction

General Meetings that have not yet reached their start time (`meeting_at`) are currently created with status `open`, allowing voting before the meeting has begun. This PRD introduces a `pending` status for meetings that haven't started yet, and enforces automatic status transitions — `pending` → `open` → `closed` — driven by `meeting_at` and `voting_closes_at` timestamps. Admins may also trigger transitions manually, which updates the relevant timestamp to now.

---

## Goals

- Meetings cannot be voted on before their start time
- Meeting status accurately reflects the lifecycle: Pending → Open → Closed
- Admins can manually start or close a meeting from the admin detail page
- Voter-facing building list shows Pending meetings with a "Not yet open" label (no Vote CTA)
- Lambda cold start auto-transitions meetings whose timestamps have been reached

---

## User Stories

### US-PS01: Add `pending` to the meeting status enum (DB + backend)

**Description:** As a developer, I need a `pending` value in the `GeneralMeetingStatus` enum and the corresponding DB migration so the new status can be stored and queried.

**Acceptance Criteria:**
- [ ] Alembic migration adds `'pending'` to the `generalmeetingstatus` PostgreSQL enum
- [ ] Migration also sets `status = 'pending'` for all existing meetings where `meeting_at > now()` and `status = 'open'`
- [ ] Migration runs cleanly against dev and test DBs; existing data for meetings with `meeting_at <= now()` is unaffected
- [ ] `GeneralMeetingStatus` Python enum updated to include `pending`
- [ ] Typecheck/lint passes

---

### US-PS02: Auto-open meetings on cold start

**Description:** As a developer, I need the Lambda cold start check to open meetings whose `meeting_at` has been reached so voters can enter at the right time.

**Acceptance Criteria:**
- [ ] The existing `auto_migrate_on_startup` function (or the auto-close block added in US-CD01) is extended to also auto-open: set `status = 'open'` for all meetings where `status = 'pending'` and `meeting_at <= now()`
- [ ] Auto-open runs before auto-close in the same startup sequence
- [ ] A meeting that transitions from `pending` → `open` in the same cold start as `open` → `closed` (i.e. both timestamps have passed) goes directly to `closed` with absent records generated
- [ ] Typecheck/lint passes

---

### US-PS03: API reflects effective status for pending meetings

**Description:** As a developer, I need all API responses that return meeting status to reflect the effective status (`pending` if `meeting_at > now()`) so the frontend always shows the correct state.

**Acceptance Criteria:**
- [ ] `GET /api/admin/general-meetings` and all routes that return meeting status derive effective status as `pending` if `meeting_at > now()` and stored status is `pending` (consistent with the existing `closed` derivation pattern from US-CD01)
- [ ] `POST /api/auth/verify` returns `agm_status: "pending"` for meetings that haven't started yet
- [ ] `POST /api/general-meeting/{id}/submit` returns 403 if meeting status is `pending`
- [ ] Typecheck/lint passes

---

### US-PS04: Admin manual start

**Description:** As a building manager, I want to manually start a pending meeting from the admin detail page so I can open voting even if the scheduled start time hasn't arrived.

**Acceptance Criteria:**
- [ ] Admin meeting detail page shows a "Start Meeting" button when the meeting status is `pending`
- [ ] Clicking "Start Meeting" calls `POST /api/admin/general-meetings/{id}/start`
- [ ] The endpoint sets `status = 'open'` and updates `meeting_at = now()`
- [ ] Returns 409 if the meeting is not in `pending` status
- [ ] Returns 404 if the meeting does not exist
- [ ] After success, the admin detail page reflects the updated status and `meeting_at` timestamp
- [ ] "Start Meeting" button is not shown for `open` or `closed` meetings
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-PS05: Admin manual close (update close time)

**Description:** As a building manager, I want manually closing a meeting to record the actual close time so the data accurately reflects when voting ended.

**Acceptance Criteria:**
- [ ] The existing `POST /api/admin/general-meetings/{id}/close` endpoint additionally sets `voting_closes_at = now()` when manually closed (only if `voting_closes_at` is in the future — do not backdate if it has already passed)
- [ ] The response includes the updated `voting_closes_at` value
- [ ] Existing close behaviour (absent records, email) is unchanged
- [ ] Typecheck/lint passes

---

### US-PS06: Voter-facing UI for pending meetings

**Description:** As a voter, I want to see that a meeting is not yet open when I visit the building list so I know when to come back.

**Acceptance Criteria:**
- [ ] The voter-facing building/meeting list shows meetings with effective status `pending` with a "Not yet open" label in place of the Vote button/CTA
- [ ] The voter frontend, upon receiving `agm_status: "pending"` from `POST /api/auth/verify`, does not navigate to the voting flow — it shows an informational message ("This meeting has not started yet") and returns the voter to the building selection page
- [ ] Pending meetings do not show a Vote CTA
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

## Functional Requirements

- FR-1: `GeneralMeetingStatus` enum gains a `pending` value stored in the DB
- FR-2: On migration, existing meetings with `meeting_at > now()` and `status = 'open'` are set to `pending`
- FR-3: Lambda cold start auto-opens meetings where `status = 'pending'` and `meeting_at <= now()`, before running the existing auto-close logic
- FR-4: A meeting that is both auto-openable and auto-closeable in the same cold start transitions directly to `closed` with absent records generated
- FR-5: All API responses derive effective status: `pending` if `meeting_at > now()`, `closed` if `voting_closes_at < now()`, otherwise stored status
- FR-6: `POST /api/auth/verify` returns `agm_status: "pending"` for not-yet-started meetings
- FR-7: Vote submission (`POST /api/general-meeting/{id}/submit`) returns 403 for `pending` meetings
- FR-8: `POST /api/admin/general-meetings/{id}/start` sets `status = 'open'` and `meeting_at = now()`; returns 409 if not pending
- FR-9: `POST /api/admin/general-meetings/{id}/close` additionally sets `voting_closes_at = now()` when `voting_closes_at` is in the future
- FR-10: Voter building list shows "Not yet open" label for pending meetings with no Vote CTA
- FR-11: Voter auth flow receiving `agm_status: "pending"` shows an informational message and returns to building selection

---

## Non-Goals

- No scheduled task or cron job — all auto-transitions happen on Lambda cold start only
- No email notification when a meeting auto-opens
- No per-meeting grace period configuration
- No `pending` → `closed` direct transition (a meeting must pass through `open` first, even if only transiently during a cold start)
- No voter notification when a pending meeting opens

---

## Technical Considerations

- **Enum migration**: PostgreSQL requires `ALTER TYPE ... ADD VALUE 'pending'` — this cannot be done inside a transaction in older Postgres versions. Use `op.execute("ALTER TYPE generalmeetingstatus ADD VALUE IF NOT EXISTS 'pending'")` outside a transaction block in Alembic (`connection.execute` with autocommit, or use a non-transactional migration).
- **Effective status derivation**: The existing pattern from US-CD01 derives `closed` from `voting_closes_at < now()`. Extend this to also derive `pending` from `meeting_at > now()`. Order of precedence: if `voting_closes_at < now()` → `closed`; else if `meeting_at > now()` → `pending`; else → `open`.
- **Startup sequence**: auto-open runs first, then auto-close. This handles the edge case where both timestamps have passed.
- **`meeting_at` update on manual start**: The frontend currently displays `meeting_at` as the scheduled start time. After a manual start, it will show the actual start time instead — this is the intended behaviour.
- **Existing close endpoint**: The `voting_closes_at` update only applies when the manual close is triggered while `voting_closes_at` is still in the future (i.e. the admin is closing early). If the close date has already passed, the stored `voting_closes_at` is preserved.

---

## Success Metrics

- Zero meetings in `open` status with `meeting_at` in the future after migration
- Voters cannot reach the voting page for a pending meeting
- Admin can open a meeting early with one click; `meeting_at` is updated to reflect actual start
- Pending meetings visible to voters with "Not yet open" label within one Lambda cold start of creation

---

## Open Questions

_None — all clarifying questions resolved._
