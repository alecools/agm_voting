# PRD: UI Improvements and Bug Fixes

## Introduction

A set of UI improvements and correctness fixes for the voting application:

1. **Back navigation** — voter-facing pages lack a way to go back, trapping users
2. **Owner edit modal** — the edit form renders at the top of the page instead of as a centred dialog
3. **Owner email editing** — admins cannot currently edit a lot owner's email addresses
4. **Motion entitlement percentages** — vote tallies show raw counts but not share of total entitlement
5. **Rename "AGM" → "General Meeting"** — the term "AGM" is replaced throughout the entire stack (DB, API, frontend) to support future meeting types such as Special General Meetings
6. **Closing date enforcement** — meetings stay "Open" past their close date; voters can still submit votes that are silently recorded as abstained. The correct behaviour is to auto-close the meeting and record absent for all non-voting lots.

---

## Goals

- Voters can always navigate back to a previous step without using the browser back button
- Admins can edit every field of a lot owner record (including emails) from a well-positioned modal
- Entitlement percentages are visible wherever vote tallies are shown, in real time and in the final report
- The system uses "General Meeting" as the canonical term everywhere
- Meetings auto-close at their close date; expired meetings cannot be voted on; absent votes are recorded automatically

---

## User Stories

### US-UI01: Back button on voter-facing pages

**Description:** As a voter, I want a back button on each step of the voting flow so I can correct mistakes without being stuck.

**Acceptance Criteria:**
- [ ] Voter verification page (`/vote/:agmId`) shows a back button that navigates to the building/AGM selection page (`/`)
- [ ] Lot selection page (`/vote/:agmId/lot-selection`) shows a back button that navigates back to the verification page
- [ ] Voting page (`/vote/:agmId/voting`) shows a back button that navigates back to the lot selection page
- [ ] Back button is visually consistent with the existing design system (secondary/ghost style)
- [ ] Back button is not shown on the confirmation page (terminal step — no going back after submission)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-UI02: Owner edit as centred modal

**Description:** As a building manager, I want the lot owner edit form to appear as a centred dialog so it doesn't displace the page layout.

**Acceptance Criteria:**
- [ ] Clicking "Edit" on a lot owner row opens a modal dialog centred on the viewport (both horizontally and vertically)
- [ ] The modal has a visible backdrop that dims the page behind it
- [ ] Clicking outside the modal or pressing Escape closes it without saving
- [ ] A "Cancel" button inside the modal also closes it without saving
- [ ] The modal is scrollable if content overflows the viewport height
- [ ] The existing edit form fields (lot number, unit entitlement, financial position) are preserved unchanged
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-UI03: Email editing in owner edit modal

**Description:** As a building manager, I want to add, edit, and remove email addresses for a lot owner from within the edit modal so I can keep contact details current.

**Acceptance Criteria:**
- [ ] The owner edit modal shows all current email addresses for the lot owner as an editable list
- [ ] Admin can add a new email address via an "Add email" input + button
- [ ] Admin can remove an existing email address via a delete/remove button next to each email
- [ ] Saving the modal calls the existing `/api/admin/lot-owners/:id/emails` add/remove endpoints as needed
- [ ] Attempting to remove the last email address shows a validation error ("A lot owner must have at least one email address") and prevents removal
- [ ] Invalid email format shows a validation error before submission
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-UI04: Entitlement percentage per motion option (admin report)

**Description:** As a building manager, I want to see what percentage of total building entitlement each vote option represents in the AGM report so I can assess the result at a glance.

**Acceptance Criteria:**
- [ ] In the admin AGM detail/report view, each tally row (For, Against, Abstained, Absent, Not eligible) shows the percentage of total building entitlement alongside the existing entitlement sum — e.g. "200 (14.3%)"
- [ ] Percentage is calculated as `entitlement_sum / total_building_entitlement * 100`, rounded to 1 decimal place
- [ ] "Total building entitlement" is the sum of all `AGMLotWeight.unit_entitlement` values for the meeting (i.e. the snapshot, not the live lot owner table)
- [ ] If total building entitlement is 0, show "—" instead of a percentage to avoid division by zero
- [ ] The percentages are also visible in the live view while the meeting is still open (not only after close)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-GM01: Rename "AGM" → "General Meeting" in database and backend

**Description:** As a developer, I need to rename the AGM entity throughout the database and backend so the codebase reflects the canonical "General Meeting" terminology.

**Acceptance Criteria:**
- [x] Alembic migration renames the `agms` table to `general_meetings`
- [x] All FK columns named `agm_id` are renamed to `general_meeting_id` (on `motions`, `agm_lot_weights`, `ballot_submissions`, `votes`, `session_records`)
- [x] The `AGMStatus` enum type in PostgreSQL is renamed to `generalmeeting_status` (or equivalent)
- [x] All SQLAlchemy model classes are renamed: `AGM` → `GeneralMeeting`, `AGMLotWeight` → `GeneralMeetingLotWeight`
- [x] All Pydantic schema classes are updated accordingly (e.g. `AGMCreate` → `GeneralMeetingCreate`)
- [x] All FastAPI route paths are updated: `/api/admin/agms` → `/api/admin/general-meetings`, `/api/agm/{id}/...` → `/api/general-meeting/{id}/...`
- [x] All service and helper functions are renamed (e.g. `create_agm` → `create_general_meeting`)
- [x] All test files updated to use new names and route paths
- [x] Migration runs cleanly against dev and test DBs; existing data is preserved
- [x] Typecheck/lint passes

---

### US-GM02: Rename "AGM" → "General Meeting" in frontend

**Description:** As a developer, I need to update all frontend routes, state keys, component names, and display text so the UI consistently uses "General Meeting".

**Acceptance Criteria:**
- [x] All user-visible text updated: "AGM" → "General Meeting", "Create AGM" → "Create General Meeting", "AGM Title" → "Meeting Title", etc.
- [x] Admin route paths updated: `/admin/agms` → `/admin/general-meetings`, `/admin/agms/:id` → `/admin/general-meetings/:id`, `/admin/agms/create` → `/admin/general-meetings/create`
- [x] Voter route paths updated: `/vote/:agmId/...` → `/vote/:meetingId/...`
- [x] All API call URLs in `src/api/` updated to use new backend paths
- [x] All `sessionStorage` keys referencing `agm_` updated to `meeting_`
- [x] All TypeScript type names and interface names updated (e.g. `AGMOut` → `GeneralMeetingOut`)
- [x] React component filenames and component function names updated where they contain "AGM" or "Agm"
- [x] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-CD01: Auto-close meetings past their closing date

**Description:** As a developer, I need the system to treat a meeting as closed when its `close_date` has passed, even if its `status` has not been manually set to `closed`.

**Acceptance Criteria:**
- [ ] `GET /api/admin/general-meetings` and all routes that return meeting status derive the effective status as `closed` if `close_date < now()` regardless of the stored `status` field
- [ ] A startup/background task runs on every Lambda cold start (alongside the existing Alembic auto-migrate) that sets `status = 'closed'` for all meetings whose `close_date < now()` and `status = 'open'`
- [ ] `POST /api/auth/verify` returns `agm_status: "closed"` (not `"open"`) for meetings past their close date
- [ ] The voter-facing building/AGM selection page shows the meeting as "Closed" when close_date has passed
- [ ] Typecheck/lint passes

---

### US-CD02: Record absent votes when a meeting closes

**Description:** As a developer, I need absent ballot submissions to be created for all lots that have not voted when a meeting is closed (manually or via close date) so the tally correctly reflects non-participation.

**Acceptance Criteria:**
- [ ] The existing `close_agm` service function already creates absent records — confirm this behaviour is correct and covers all lots in `GeneralMeetingLotWeight`
- [ ] The new auto-close task (US-CD01) calls the same absent-record generation logic after setting status to `closed`
- [ ] A lot that already has a `BallotSubmission` is not given a second absent record
- [ ] After auto-close, `GET /api/admin/general-meetings/:id` tally shows the correct absent count (total lots minus submitted lots)
- [ ] Typecheck/lint passes

---

### US-UI05: Building filter on General Meetings list

**Description:** As a building manager, I want to filter the General Meetings list by building so I can quickly find meetings for a specific building when managing multiple buildings.

**Acceptance Criteria:**
- [ ] A single-select dropdown labelled "All buildings" appears above the General Meetings table
- [ ] Selecting a building from the dropdown filters the table to show only meetings for that building
- [ ] Selecting "All buildings" (the default/empty option) removes the filter and shows all meetings
- [ ] The selected building is stored in the URL as a `?building=<id>` search param
- [ ] On page load, if `?building=<id>` is present in the URL, the matching building is pre-selected and the table is filtered
- [ ] Changing the filter updates the URL without triggering a full page navigation
- [ ] Filtering is client-side — no additional API call is made when the filter changes
- [ ] The table, pagination, and loading states are unchanged; only the data passed to the table is filtered
- [ ] Typecheck/lint passes

---

### US-CD03: Block voters from entering expired meetings

**Description:** As a voter, I should not be able to reach the voting page for a meeting that is past its closing date, so my votes are not silently discarded.

**Acceptance Criteria:**
- [ ] `POST /api/auth/verify` returns `agm_status: "closed"` for meetings past their close date (covered by US-CD01)
- [ ] The voter frontend, upon receiving `agm_status: "closed"` from the auth endpoint, navigates directly to the confirmation/read-only screen instead of the voting page — this existing behaviour from the manual-close flow applies equally to auto-closed meetings
- [ ] The voter-facing building list does not show a "Vote" CTA for meetings that are past their close date
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

## Functional Requirements

- FR-1: Back button appears on voter verification, lot selection, and voting pages; navigates to the previous step
- FR-2: Lot owner edit form is rendered as a centred viewport-dimming modal dialog
- FR-3: Owner edit modal includes an editable list of email addresses with add/remove actions
- FR-4: Removing the last email address is blocked with a validation error
- FR-5: Each tally row in the admin report shows `entitlement_sum (X.X%)` where % = entitlement_sum / total snapshot entitlement × 100
- FR-6: Entitlement percentages are shown in the live (open) admin view, not only the final report
- FR-7: The `agms` table and all related DB objects are renamed to `general_meetings` via Alembic migration
- FR-8: All API route paths, frontend routes, TypeScript types, component names, and display strings use "General Meeting" (not "AGM")
- FR-9: A meeting is treated as `closed` if `close_date < now()`, regardless of the stored `status` value
- FR-10: On Lambda cold start, meetings with `close_date < now()` and `status = 'open'` are automatically set to `closed` and absent ballot submissions are generated for all non-voting lots
- FR-11: Voters cannot reach the voting page for a meeting that is past its close date; they are routed to the read-only confirmation screen
- FR-12: The General Meetings list page has a single-select building filter dropdown; filter state is persisted as a `?building=<id>` URL search param; filtering is client-side

---

## Non-Goals

- No "Special General Meeting" type field is added in this PRD — the rename to "General Meeting" lays the groundwork only; the meeting-type selector is a separate feature
- No email notification to lot owners when a meeting auto-closes
- No admin UI to configure the auto-close behaviour (e.g. grace period)
- No change to how manually-closed meetings work — the existing `POST /api/admin/general-meetings/:id/close` endpoint is unchanged in behaviour
- No retrospective fix for meetings that were already incorrectly left open and had votes recorded as abstained

---

## Technical Considerations

- **Rename migration:** Use `op.rename_table` and `op.alter_column` in Alembic. The PostgreSQL enum type rename requires `ALTER TYPE ... RENAME TO ...` via `op.execute`. All FK constraints referencing the old column names must be dropped and recreated.
- **Auto-close on cold start:** The existing `auto_migrate_on_startup` function in `api/index.py` is the right place to add the auto-close check — run it after Alembic migrations complete.
- **Entitlement total:** Use `SUM(GeneralMeetingLotWeight.unit_entitlement)` per meeting — this is the snapshot total, not the live lot owner table.
- **Frontend route rename:** React Router `<Route>` paths and `useParams` param names must both be updated. Any `useNavigate` hard-coded paths must also be updated. Playwright E2E tests reference URLs and must be updated.
- **SessionStorage keys:** Voter flow uses `agm_lots_${agmId}`, `agm_lots_info_${agmId}`, `agm_lot_info_${agmId}` — rename to `meeting_lots_${meetingId}` etc.

---

## Success Metrics

- Voters can navigate back to any previous step without using browser navigation
- Admin can fully manage a lot owner's details (including emails) from a single centred dialog
- Entitlement percentages visible in admin report within 1 second of page load
- Zero occurrences of the string "AGM" in user-visible UI text after the rename
- Meetings with a past close date show as "Closed" in all views within one Lambda cold start of the deadline passing
- Absent tally correctly accounts for all lots that did not vote when a meeting closes

---

## Open Questions

_None — all clarifying questions resolved._
