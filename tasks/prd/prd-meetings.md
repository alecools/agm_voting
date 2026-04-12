# PRD: Meeting Lifecycle

## Introduction

This document covers the full lifecycle of a General Meeting: creation, pending/open/close/delete transitions, per-motion voting windows, and related admin management flows. A meeting progresses through `pending` → `open` → `closed` states driven by `meeting_at` and `voting_closes_at` timestamps, with manual overrides available to the admin.

---

## Goals

- Meetings cannot be voted on before their start time (`pending` status)
- Meeting status accurately reflects the lifecycle: Pending → Open → Closed
- Admins can manually start or close a meeting from the admin detail page
- Lambda cold start auto-transitions meetings whose timestamps have been reached
- Admins can delete closed or pending meetings to remove test/incorrect records
- Only one open meeting may exist per building at a time
- Admins can manually close voting on individual motions while the overall meeting remains open

---

## User Stories

### US-001: Create a new General Meeting

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to create a new General Meeting so that lot owners can vote on motions for an upcoming meeting.

**Acceptance Criteria:**

- [ ] Host can create a meeting (from the admin portal) by providing: building selection, meeting title, meeting date/time, scheduled voting close date/time, and one or more motions (each with a title, optional description, optional motion number, and motion type)
- [ ] Scheduled voting close date/time must be after the meeting date/time; validation error shown if not
- [ ] Each motion is stored with a display order (1-based integer) and an optional motion number string
- [ ] On creation, meetings start in `pending` status if `meeting_at` is in the future, or `open` if `meeting_at` is in the past or present
- [ ] On creation, the system snapshots the unit entitlement and financial position of every lot in the building into an immutable `agm_lot_weights` record; this snapshot is used for all tally calculations regardless of future lot owner data changes
- [ ] Meeting has a shareable URL that the host can copy and send to lot owners
- [ ] Only one open meeting may exist per building at a time; attempting to create a second is rejected with a clear error (409)
- [ ] Typecheck/lint passes

---

### US-PS01: Add `pending` to the meeting status enum (DB + backend)

**Status:** ✅ Implemented

**Description:** As a developer, I need a `pending` value in the `GeneralMeetingStatus` enum and the corresponding DB migration so the new status can be stored and queried.

**Acceptance Criteria:**

- [x] Alembic migration adds `'pending'` to the `generalmeetingstatus` PostgreSQL enum
- [x] Migration also sets `status = 'pending'` for all existing meetings where `meeting_at > now()` and `status = 'open'`
- [x] Migration runs cleanly against dev and test DBs; existing data for meetings with `meeting_at <= now()` is unaffected
- [x] `GeneralMeetingStatus` Python enum updated to include `pending`
- [ ] Typecheck/lint passes

---

### US-PS02: Auto-open meetings on cold start

**Status:** ✅ Implemented

**Description:** As a developer, I need the Lambda cold start check to open meetings whose `meeting_at` has been reached so voters can enter at the right time.

**Acceptance Criteria:**

- [x] The existing `auto_migrate_on_startup` function is extended to also auto-open: set `status = 'open'` for all meetings where `status = 'pending'` and `meeting_at <= now()`
- [x] Auto-open runs before auto-close in the same startup sequence
- [x] A meeting that transitions from `pending` → `open` in the same cold start as `open` → `closed` (i.e. both timestamps have passed) goes directly to `closed` with absent records generated
- [x] Typecheck/lint passes

---

### US-PS03: API reflects effective status for pending meetings

**Status:** ✅ Implemented

**Description:** As a developer, I need all API responses that return meeting status to reflect the effective status (`pending` if `meeting_at > now()`) so the frontend always shows the correct state.

**Acceptance Criteria:**

- [x] `GET /api/admin/general-meetings` and all routes that return meeting status derive effective status: `closed` if `voting_closes_at < now()`, `pending` if `meeting_at > now()`, otherwise `open`
- [x] `POST /api/auth/verify` returns `agm_status: "pending"` for meetings that haven't started yet
- [x] `POST /api/general-meeting/{id}/submit` returns 403 if meeting status is `pending`
- [x] Typecheck/lint passes

---

### US-PS04: Admin manual start

**Status:** ✅ Implemented

**Description:** As a building manager, I want to manually start a pending meeting from the admin detail page so I can open voting even if the scheduled start time hasn't arrived.

**Acceptance Criteria:**

- [x] Admin meeting detail page shows a "Start Meeting" button when the meeting status is `pending`
- [x] Clicking "Start Meeting" calls `POST /api/admin/general-meetings/{id}/start`
- [x] The endpoint sets `status = 'open'` and updates `meeting_at = now()`
- [x] Returns 409 if the meeting is not in `pending` status
- [x] Returns 404 if the meeting does not exist
- [x] After success, the admin detail page reflects the updated status and `meeting_at` timestamp
- [x] "Start Meeting" button is not shown for `open` or `closed` meetings
- [x] Typecheck/lint passes

---

### US-PS05: Admin manual close (update close time)

**Status:** ✅ Implemented

**Description:** As a building manager, I want manually closing a meeting to record the actual close time so the data accurately reflects when voting ended.

**Acceptance Criteria:**

- [x] The existing `POST /api/admin/general-meetings/{id}/close` endpoint additionally sets `voting_closes_at = now()` when manually closed (only if `voting_closes_at` is in the future — do not backdate if it has already passed)
- [x] The response includes the updated `voting_closes_at` value
- [x] Existing close behaviour (absent records, email) is unchanged
- [x] Typecheck/lint passes

---

### US-PS06: Voter-facing UI for pending meetings

**Status:** ✅ Implemented

**Description:** As a voter, I want to see that a meeting is not yet open when I visit the building list so I know when to come back.

**Acceptance Criteria:**

- [x] The voter-facing building/meeting list shows meetings with effective status `pending` with a "Not yet open" label in place of the Vote button/CTA
- [x] The voter frontend, upon receiving `agm_status: "pending"` from `POST /api/auth/verify`, shows an informational message ("This meeting has not started yet") and returns the voter to the building selection page
- [x] Pending meetings do not show a Vote CTA
- [ ] Typecheck/lint passes

---

### US-007: Close meeting and send results report

**Status:** ✅ Implemented

**Description:** As a meeting manager, I want to close voting and receive a results report so I can record the meeting outcome.

**Acceptance Criteria:**

- [ ] Manager can close an open meeting via a "Close Voting" button in the admin portal
- [ ] On close: meeting status changes to "closed"; all voting inputs are disabled for lot owners; all remaining draft votes are discarded and those voters are recorded as absent
- [ ] System attempts to send one HTML email to the manager email address stored against the building
- [ ] If send fails, the system retries with exponential backoff up to a maximum of 30 attempts; retry schedule and outcomes are logged using OTEL-compliant structured logging
- [ ] If all 30 retries are exhausted, the admin portal displays a clear, persistent error banner: "Results report could not be delivered to [email]. Please retry manually or download the report."
- [ ] A "Retry Send" button resets and restarts the retry sequence for any meeting whose report failed to deliver
- [ ] The report (viewable in-app and sent by email) includes a summary and, for each motion: motion title and description, total Yes/No/Abstained/Absent (voter count + weighted unit entitlements), not-eligible counts for in-arrear lots, per-option tallies for multi-choice motions
- [ ] Voter lists show **lot numbers and individual entitlements** (not email addresses) to protect privacy; one row per lot
- [ ] Host can export the full voter breakdown as a CSV file via an "Export voter lists (CSV)" button
- [ ] The exported CSV includes a "Voter Email" column on every row (direct votes: submitter email; proxy votes: `proxy@example.com (proxy: proxy@example.com)`; absent lots: all registered owner emails comma-separated; no-email lots: empty cell)
- [ ] Typecheck/lint passes

---

### US-CD01: Auto-close meetings past their closing date

**Status:** ✅ Implemented

**Description:** As a developer, I need the system to treat a meeting as closed when its `voting_closes_at` has passed, even if its `status` has not been manually set to `closed`.

**Acceptance Criteria:**

- [ ] `GET /api/admin/general-meetings` and all routes that return meeting status derive the effective status as `closed` if `voting_closes_at < now()` regardless of the stored `status` field
- [ ] A startup task runs on every Lambda cold start that sets `status = 'closed'` for all meetings whose `voting_closes_at < now()` and `status = 'open'`
- [ ] `POST /api/auth/verify` returns `agm_status: "closed"` (not `"open"`) for meetings past their close date
- [ ] The voter-facing building/meeting selection page shows the meeting as "Closed" when `voting_closes_at` has passed
- [ ] Typecheck/lint passes

---

### US-CD02: Record absent votes when a meeting closes

**Status:** ✅ Implemented

**Description:** As a developer, I need absent ballot submissions to be created for all lots that have not voted when a meeting is closed (manually or via close date) so the tally correctly reflects non-participation.

**Acceptance Criteria:**

- [ ] The existing `close_general_meeting` service function creates absent records for all lots in `GeneralMeetingLotWeight` that do not have a `BallotSubmission`
- [ ] The auto-close task calls the same absent-record generation logic after setting status to `closed`
- [ ] A lot that already has a `BallotSubmission` is not given a second absent record
- [ ] **Absent count is only computed and shown for closed meetings.** For open or pending meetings the absent count is 0 and is not displayed in the admin tally
- [ ] Typecheck/lint passes

---

### US-CD03: Block voters from entering expired meetings

**Status:** ✅ Implemented

**Description:** As a voter, I should not be able to reach the voting page for a meeting that is past its closing date.

**Acceptance Criteria:**

- [ ] `POST /api/auth/verify` returns `agm_status: "closed"` for meetings past their close date (covered by US-CD01)
- [ ] The voter frontend, upon receiving `agm_status: "closed"` from the auth endpoint, navigates directly to the confirmation/read-only screen instead of the voting page
- [ ] The voter-facing building list does not show a "Vote" CTA for meetings that are past their close date
- [ ] Typecheck/lint passes

---

### US-DM01: Delete a closed or pending meeting

**Status:** ✅ Implemented

**Description:** As a building manager, I want to delete a meeting that is in a closed or pending state so I can remove test meetings or incorrectly created meetings.

**Acceptance Criteria:**

- [x] A "Delete Meeting" button is visible on the General Meeting detail page when the meeting status is `closed` or `pending`
- [x] The button is not shown for meetings with status `open` — open meetings cannot be deleted
- [x] Clicking "Delete Meeting" shows a browser confirmation dialog before proceeding
- [x] On confirmation, `DELETE /api/admin/general-meetings/{id}` is called; returns 204 on success; returns 404 if the meeting does not exist; returns 409 if the meeting status is `open`
- [x] On successful deletion, the admin is navigated to the General Meetings list page
- [x] The button is disabled and shows "Deleting…" while the request is in flight
- [x] Typecheck/lint passes

---

### US-UI05: Building filter on General Meetings list

**Status:** ✅ Implemented

**Description:** As a building manager, I want to filter the General Meetings list by building so I can quickly find meetings for a specific building when managing multiple buildings.

**Acceptance Criteria:**

- [x] A single-select dropdown labelled "All buildings" appears above the General Meetings table
- [x] Selecting a building from the dropdown filters the table to show only meetings for that building
- [x] Selecting "All buildings" (the default/empty option) removes the filter and shows all meetings
- [x] The selected building is stored in the URL as a `?building=<id>` search param
- [x] On page load, if `?building=<id>` is present in the URL, the matching building is pre-selected and the table is filtered
- [x] Changing the filter updates the URL without triggering a full page navigation
- [x] Filtering is client-side — no additional API call is made when the filter changes
- [x] Typecheck/lint passes

---

### US-GM01: Rename "AGM" → "General Meeting" in database and backend

**Status:** ✅ Implemented

**Description:** As a developer, I need to rename the AGM entity throughout the database and backend so the codebase reflects the canonical "General Meeting" terminology.

**Acceptance Criteria:**

- [x] Alembic migration renames the `agms` table to `general_meetings`
- [x] All FK columns named `agm_id` are renamed to `general_meeting_id`
- [x] All SQLAlchemy model classes are renamed: `AGM` → `GeneralMeeting`, `AGMLotWeight` → `GeneralMeetingLotWeight`
- [x] All FastAPI route paths updated: `/api/admin/agms` → `/api/admin/general-meetings`, `/api/agm/{id}/...` → `/api/general-meeting/{id}/...`
- [x] All test files updated to use new names and route paths
- [x] Migration runs cleanly against dev and test DBs; existing data is preserved
- [x] Typecheck/lint passes

---

### US-GM02: Rename "AGM" → "General Meeting" in frontend

**Status:** ✅ Implemented

**Description:** As a developer, I need to update all frontend routes, state keys, component names, and display text so the UI consistently uses "General Meeting".

**Acceptance Criteria:**

- [x] All user-visible text updated: "AGM" → "General Meeting", "Create AGM" → "Create General Meeting", etc.
- [x] Admin route paths updated: `/admin/agms` → `/admin/general-meetings`, etc.
- [x] Voter route paths updated: `/vote/:agmId/...` → `/vote/:meetingId/...`
- [x] All API call URLs in `src/api/` updated to use new backend paths
- [x] All `sessionStorage` keys referencing `agm_` updated to `meeting_`
- [x] All TypeScript type names and interface names updated (e.g. `AGMOut` → `GeneralMeetingOut`)
- [x] React component filenames and component function names updated
- [x] Typecheck/lint passes

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
- [ ] Voters who have not submitted a vote for the motion at the time of closure are immediately recorded as absent for that motion
- [ ] `Motion` gains a `voting_closed_at` (TIMESTAMPTZ, nullable) column; `null` means voting is still open for that motion
- [ ] `POST /api/admin/motions/{id}/close` sets `voting_closed_at = now()` on the motion; returns 409 if already closed; returns 409 if the meeting is closed
- [ ] When `POST /api/admin/general-meetings/{id}/close` is called, all motions with `voting_closed_at IS NULL` have their `voting_closed_at` set to the meeting's `closed_at`
- [ ] Vote submissions reject any vote for a motion where `voting_closed_at IS NOT NULL`; returns 422 with detail `"Voting has closed for motion: {motion_number}"`
- [ ] `GET /api/general-meeting/{id}/motions` returns `voting_closed_at` on each `MotionOut` so the frontend can disable controls immediately
- [ ] A motion can only be closed if it is currently visible (`is_visible = true`); attempting to close a hidden motion returns 409 with detail `"Motion must be visible before closing"`
- [ ] A closed motion cannot be hidden again; `PATCH /api/admin/motions/{id}/visibility` returns 409 when attempting to hide a motion with `voting_closed_at IS NOT NULL`
- [ ] The tally for a closed motion counts only votes submitted before `voting_closed_at`; lots with no submitted vote before that timestamp are counted as absent
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-PMW-02: Voter sees per-motion close status in real time

**Status:** Pending

**Description:** As a lot owner on the voting page, I want to see when individual motions have had their voting window closed so that I am not confused by suddenly disabled controls.

**Acceptance Criteria:**

- [ ] The voting page polls `GET /api/general-meeting/{id}/motions` every 10 s
- [ ] When a motion's `voting_closed_at` becomes non-null in a poll response, that motion's vote controls are immediately disabled and a "Voting closed" label replaces the vote buttons
- [ ] A motion that was already locked (`voting_closed_at` non-null on initial load) shows the "Voting closed" label from the first render
- [ ] The progress bar denominator excludes motions whose `voting_closed_at` is non-null and for which the voter has not yet voted
- [ ] If the voter has already voted on a motion that subsequently has its `voting_closed_at` set, the motion shows their submitted choice (read-only) as normal
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AUIF-08: Admin view — closed motion shows a styled "Voting Closed" badge

**Status:** ✅ Implemented

**Description:** As a meeting admin, I want the "Voting Closed" status for individually closed motions to be displayed as a styled pill badge rather than plain unstyled text.

**Acceptance Criteria:**

- [ ] When a motion's voting has been closed (`voting_closed_at` is set), the "Close Motion" button is replaced by a styled red pill badge labelled "Voting Closed"
- [ ] The badge uses the design system's red status colour (`var(--red)` on `var(--red-bg)`) with a pill border radius (`999px`)
- [ ] The badge has `aria-label="Motion voting closed"` for accessibility
- [ ] Typecheck/lint passes

---

### US-AUIF-09: Voter view — individually closed motion shows "Motion Closed" inside the card

**Status:** ✅ Implemented

**Description:** As a voter, I want to see a clear "Motion Closed" indicator inside the motion card so the closed state is visually associated with the correct motion.

**Acceptance Criteria:**

- [ ] When a motion's voting has been individually closed, a styled "Motion Closed" badge appears inside the motion card, below the title/description and above the (disabled) vote buttons
- [ ] The badge uses the red status pill style (matching US-AUIF-08)
- [ ] The external plain-text "Voting closed" label above the card is removed
- [ ] The `role="status"` attribute is retained on the closed indicator
- [ ] Typecheck/lint passes

---

## Functional Requirements

- FR-2: A General Meeting belongs to one building, has a status (`pending` | `open` | `closed`), a title, a meeting date/time (`meeting_at`), and a scheduled voting close date/time (`voting_closes_at`). `voting_closes_at` must be after `meeting_at`. Both fields are stored in UTC.
- Effective status derivation: if `voting_closes_at < now()` → `closed`; else if `meeting_at > now()` → `pending`; else → `open`.
- FR-10: Only one active (open) meeting can exist per building at a time. Creating a second is rejected with a 409 error.
- FR-14: At meeting creation, the system records an immutable weight snapshot (`GeneralMeetingLotWeight`) containing the `unit_entitlement` and `financial_position_snapshot` of every lot owner in the building at that moment. All tally calculations use this snapshot exclusively.
- Auto-transitions happen on Lambda cold start only; no scheduled cron jobs.
- `POST /api/admin/general-meetings/{id}/start` sets `status = 'open'` and updates `meeting_at = now()`; returns 409 if not pending.
- `POST /api/admin/general-meetings/{id}/close` sets `status = 'closed'`, sets `voting_closes_at = now()` if it is in the future, and creates absent records for all non-voting lots.
- `DELETE /api/admin/general-meetings/{id}` returns 409 if the meeting is `open`.

---

## Non-Goals

- No scheduled task or cron job — all auto-transitions happen on Lambda cold start only
- No email notification when a meeting auto-opens or auto-closes
- No per-meeting grace period configuration
- No `pending` → `closed` direct transition (a meeting must pass through `open` first, even if only transiently during a cold start)
- No voter notification when a pending meeting opens
- No editing of meeting title, date, or close time after creation
- Reopening a per-motion-closed motion is not supported (irreversible once closed)
