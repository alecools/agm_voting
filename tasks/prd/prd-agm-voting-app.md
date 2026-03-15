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

### US-001: Create a new AGM

**Description:** As a meeting host, I want to create a new AGM so that lot owners can vote on motions for an upcoming meeting.

**Acceptance Criteria:**

- [ ] Host can create an AGM (from the admin portal) by providing: building selection, meeting title, meeting date/time, scheduled voting close date/time, and one or more motions (each with a title and description)
- [ ] Scheduled voting close date/time must be after the meeting date/time; validation error shown if not
- [ ] Each motion is stored with an ordered index
- [ ] AGM is created in "open" status immediately — there is no draft state
- [ ] On creation, the system snapshots the unit entitlement of every lot in the building into an immutable `agm_lot_weights` record (see FR-14); this snapshot is used for all tally calculations for this AGM regardless of future lot owner data changes
- [ ] AGM has a shareable URL that the host can copy and send to lot owners
- [ ] Once created, the AGM and its motions are immutable — no edits are permitted regardless of status (see FR-11)
- [ ] Only one open AGM may exist per building at a time; attempting to create a second is rejected with a clear error
- [ ] Typecheck/lint passes

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

**Description:** As a lot owner, I want to enter my lot number and email so the system can verify I am eligible to vote.

**Acceptance Criteria:**

- [ ] Lot owner enters lot number and email address
- [ ] System checks that the lot number + email combination exists in the database for the selected building
- [ ] On match: system identifies all lots in that building registered to the same email; a session is created scoped to that email + building + AGM
- [ ] If the lot owner has already submitted a ballot for this AGM, they are taken directly to the confirmation screen (US-009)
- [ ] If the lot owner has not yet submitted, they are taken to the voting page with a fresh ballot (no server-side draft restoration)
- [ ] On no match: a clear error message is shown ("Lot number and email address do not match our records")
- [ ] No account creation or password required
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

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

## Functional Requirements

- FR-1: A building record contains: name, manager email address, and associated lot owner records. Buildings can be created individually via a form (POST /api/admin/buildings) or bulk-created/updated via CSV or Excel upload (US-012). Building names must be globally unique (case-insensitive).
- FR-2: An AGM belongs to one building, has a status (`open` | `closed`), a title, a meeting date/time (`meeting_at`), and a scheduled voting close date/time (`voting_closes_at`). `voting_closes_at` must be after `meeting_at`. Both fields are stored in UTC and are immutable after creation.
- FR-3: A lot owner record contains: building ID, lot number (string), email address, and unit entitlement (non-negative integer). Lot number must be unique per building. Multiple lots may share the same email address within a building (multi-lot owners). Lot owner records cannot be deleted — only created or edited.
- FR-4: Authentication is session-based — after verifying lot number + email, the system identifies all lot owner records in that building sharing the same email, and a server-side session is created scoped to that email + building + AGM. Session data is persisted in the database to support draft vote resumption across session restarts. No JWT or OAuth required for MVP.
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
