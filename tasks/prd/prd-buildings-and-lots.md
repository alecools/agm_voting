# PRD: Buildings and Lot Owners

## Introduction

This document covers all building management, lot owner management, CSV/Excel import, financial positions (in-arrear), proxy nominations, and owner names for the AGM Voting App.

---

## Goals

- Allow hosts to create, edit, archive, and delete buildings; lot owners are managed per building
- Support bulk import of lot owners (CSV/Excel) with upsert semantics that preserve existing AGM snapshots
- Support financial positions (in-arrear/normal) per lot, bulk-importable and editable in the admin UI
- Support proxy nominations per lot, bulk-importable and editable in the admin UI
- Store optional given name and surname per owner email and proxy contact

---

## User Stories

### US-011: Host admin portal

**Status:** ✅ Implemented

**Description:** As a meeting host, I want a dedicated admin portal so I can manage buildings, lot owners, and meetings separate from the lot owner–facing voting flow.

**Acceptance Criteria:**

- [ ] A separate web route (e.g. `/admin`) serves the host portal; it is distinct from the lot owner flow
- [ ] The portal provides navigation to: Buildings, Meetings, and Lot Owners sections
- [ ] Admin portal login is required (see US-020)
- [ ] Typecheck/lint passes

---

### US-019: Archive buildings and associated lot owners

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to archive a building so it no longer appears in the voter portal, and have its lot owners archived too unless they belong to another active building.

**Acceptance Criteria:**

- [ ] Admin can archive a building via a button on the building detail page; a confirmation dialog is shown before archiving
- [ ] Archiving sets `is_archived = true` on the building
- [ ] Archiving also sets `is_archived = true` on every lot owner in the building, unless that lot owner's email also appears as a lot owner in another non-archived building
- [ ] Attempting to archive an already-archived building returns 409
- [ ] Archived buildings are excluded from the voter-facing building dropdown (`GET /api/buildings`)
- [ ] Archived buildings are excluded from the voter-facing meeting list (`GET /api/buildings/{id}/general-meetings` returns 404 for archived buildings)
- [ ] Archived buildings still appear in the admin portal buildings list, with a visual "Archived" badge; they can be clicked to view details
- [ ] Admin buildings list includes a toggle to show/hide archived buildings (default: show active only)
- [ ] Typecheck/lint passes

---

### US-BLD-DELETE: Delete an archived building

**Status:** ✅ Implemented

**Description:** As a building manager, I want to permanently delete a building that has been archived so I can remove test or incorrectly created buildings from the system.

**Acceptance Criteria:**

- [x] `DELETE /api/admin/buildings/:id` endpoint added
- [x] Returns 204 on success; the building and all cascade data (lot owners, lot weights, ballot submissions, votes, session records, motions, meetings) are deleted
- [x] Returns 404 if the building does not exist
- [x] Returns 409 if the building is not archived (only archived buildings can be deleted)
- [x] A "Delete Building" button is visible on the building detail/edit page only when the building is archived
- [x] Clicking the button shows a browser confirmation dialog before proceeding
- [x] On success, admin is navigated to the buildings list
- [x] Button shows "Deleting…" while the request is in flight
- [x] Typecheck/lint passes
- [x] All tests pass at 100% coverage

---

### US-012: Create and manage buildings via form or CSV/Excel upload

**Status:** ✅ Implemented

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

---

### US-BLD-01: Edit building name and manager email

**Status:** ✅ Implemented

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

**Status:** ✅ Implemented

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

### US-005: Import lot owner data via CSV or Excel

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to upload a CSV or Excel file of lot owners so the system can authenticate them during the meeting.

**Acceptance Criteria:**

- [ ] Host can upload a CSV or Excel (.xlsx / .xls) file; the file input accepts both formats
- [ ] CSV format accepts canonical headers (`lot_number`, `email`, `unit_entitlement`) **or** SBT aliases (`Lot#` → lot_number, `UOE2` → unit_entitlement, `Email` → email); both naming conventions work interchangeably
- [ ] Excel format (matching the `Owners_SBT.xlsx` template in `examples/`) uses headers: `Lot#` (lot number), `UOE2` (unit entitlement), `Email` (email address); other columns are ignored
- [ ] System validates the file format and reports errors (missing required columns, duplicate lot numbers, blank required fields) before importing
- [ ] Successful import shows count of records imported
- [ ] Import uses upsert semantics: existing lot owners matched by `lot_number` are updated in-place (preserving their database ID), new lot numbers are inserted, lot numbers absent from the import file are deleted
- [ ] Upsert preserves `AGMLotWeight` snapshots for any open/closed meetings — re-importing lot owners must NOT zero out entitlement sums in existing meeting tallies
- [ ] Typecheck/lint passes

---

### US-V04: Update lot owner import to support multiple emails and empty emails

**Status:** ✅ Implemented

**Description:** As a meeting host, I want the lot owner import to accept multiple email rows for the same lot and allow rows with no email, so I can import exactly what the strata roll contains.

**Acceptance Criteria:**

- [ ] Import file may contain multiple rows with the same `Lot#` / `lot_number` and different emails — all emails are stored as separate `LotOwnerEmail` records for that lot
- [ ] If multiple rows share the same `Lot#`, the `UOE2`/`unit_entitlement` and `Financial Position` values are taken from the **first** row for that lot; subsequent rows for the same lot need only the email (other columns are ignored after the first row)
- [ ] A row with a blank or missing `Email` column is accepted: the lot is created/updated as normal but no `LotOwnerEmail` row is created for that blank value
- [ ] Import upsert behaviour (by lot number within building) is preserved — re-importing updates entitlement and financial position, and replaces the full set of emails for that lot (delete all existing emails for the lot then insert the new set)
- [ ] Duplicate emails within the same lot in the import file are silently deduplicated (not rejected)
- [ ] Lots absent from the import file are deleted as before
- [ ] Successful import shows count of lots imported and total emails recorded
- [ ] Typecheck/lint passes

---

### US-010: Manually add or edit a lot owner via UI

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to add or edit a lot owner record directly in the UI so I can make quick corrections without re-uploading a CSV.

**Acceptance Criteria:**

- [ ] Host can add a new lot owner by entering: lot number, email address, and unit entitlement
- [ ] Host can edit an existing lot owner's email address or unit entitlement; clicking "Edit" on a row opens a centred modal dialog pre-filled with current values
- [ ] Lot owner records cannot be deleted via the UI (deletion is not supported)
- [ ] Duplicate lot numbers within the same building are rejected with a validation error
- [ ] Changes take effect immediately for authentication purposes but do not affect the weight snapshot of any already-open meeting (see FR-14)
- [ ] The building detail page includes a "Create Meeting" button that navigates directly to the meeting creation form
- [ ] Typecheck/lint passes

---

### US-LOE-01: Optional lot owner email

**Status:** ✅ Implemented

**Description:** As an admin, I want to add a lot owner without an email address, so that buildings with owners who have no email can still be managed in the system.

**Acceptance Criteria:**

- [ ] The email field in the Add Lot Owner form is optional; the input shows hint text "Leave blank if no email address"
- [ ] Leaving the email field blank is accepted — the form submits without error and the lot owner is created with zero email records
- [ ] A non-blank email value is still validated for correct format; an invalid format shows the inline error "Please enter a valid email address."
- [ ] All email addresses are normalised to lowercase before storage and before OTP lookup
- [ ] CSV import accepts rows where the email cell is blank or the email column is absent entirely; those lot owners are created without email records
- [ ] The EditModal's "Remove" button on the last email address is not blocked — removing the last email is permitted, leaving the owner with zero emails
- [ ] Owners with no email are always recorded as absent at meeting close
- [ ] The absent tally and CSV export for an email-less owner show a blank "Voter Email" cell
- [ ] Lot owner table shows a blank email column for email-less owners
- [ ] Typecheck/lint passes

---

### US-V03: Refactor lot owner emails to a separate `LotOwnerEmail` table

**Status:** ✅ Implemented

**Description:** As a developer, I need to support multiple email addresses per lot so that any authorised contact can vote for that lot.

**Acceptance Criteria:**

- [ ] New table `lot_owner_emails` with columns: `id` (UUID PK), `lot_owner_id` (FK → `lot_owners.id` CASCADE DELETE), `email` (String, nullable)
- [ ] Unique constraint on `(lot_owner_id, email)` (two nulls are allowed — DB-level nulls are not equal)
- [ ] Index on `email` for fast lookup by email during authentication
- [ ] `email` column removed from `lot_owners` table
- [ ] Existing `lot_owners.email` values migrated to new `lot_owner_emails` rows
- [ ] `AGMLotWeight.voter_email` column removed — lot weights are now associated via `lot_owner_id` alone; `voter_email` is stored on `BallotSubmission` only (for audit)
- [ ] Migration generated and runs cleanly
- [ ] Typecheck/lint passes

---

### US-V02: Add `financial_position` field to lot owners

**Status:** ✅ Implemented

**Description:** As a developer, I need lot owners to carry a financial position so the system can restrict in-arrear lots from voting on General Motions.

**Acceptance Criteria:**

- [ ] Add `financial_position` column to `lot_owners` table: `'normal'` | `'in_arrear'`, NOT NULL, default `'normal'`
- [ ] Migration generated and runs cleanly
- [ ] Existing lot owners are migrated with `financial_position = 'normal'`
- [ ] `financial_position` is included in lot owner import (column `Financial Position` or `financial_position`); accepted values `Normal`, `In Arrear` (case-insensitive); blank/missing defaults to `normal`
- [ ] `financial_position` is returned in admin lot owner API responses
- [ ] Typecheck/lint passes

---

### US-V10: Show financial position on admin lot owner detail page

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to see each lot's financial position in the admin portal so I can verify eligibility before a meeting.

**Acceptance Criteria:**

- [ ] The lot owner row in the admin building detail page shows a "Financial Position" column: "Normal" or "In Arrear"
- [ ] "In Arrear" lots display a visible badge/tag to draw attention
- [ ] The lot owner edit form includes a "Financial Position" dropdown (Normal / In Arrear); updating it saves correctly
- [ ] The lot owner add form includes the same "Financial Position" dropdown (default: Normal)
- [ ] Typecheck/lint passes

---

### US-V11: Show emails list on admin lot owner detail page

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to see all email addresses associated with each lot in the admin portal so I can verify and manage contact details.

**Acceptance Criteria:**

- [ ] The lot owner row or detail view in the admin building detail page shows all associated email addresses (comma-separated or as a list)
- [ ] Admin can add an additional email address to a lot via a form field
- [ ] Admin can remove an email address from a lot (with a confirmation prompt); a lot may end up with zero emails
- [ ] The lot owner import (US-V04) is reflected correctly — re-importing updates both the lot fields and its email set
- [ ] Typecheck/lint passes

---

### US-PX01: Proxy nomination data model

**Status:** ✅ Implemented

**Description:** As a developer, I need a `lot_proxy` table so proxy nominations can be stored and queried at the building level.

**Acceptance Criteria:**

- [ ] New table `lot_proxy`: `id` (UUID PK), `lot_owner_id` (FK → `lot_owners.id` CASCADE DELETE, UNIQUE), `proxy_email` (String NOT NULL), `given_name` (VARCHAR, nullable), `surname` (VARCHAR, nullable), `created_at` (datetime)
- [ ] Unique constraint on `lot_owner_id` — one proxy per lot at a time
- [ ] Index on `proxy_email` for fast lookup during authentication
- [ ] Migration generated and runs cleanly against dev and test DBs
- [ ] `BallotSubmission` gains a nullable `proxy_email` (String) column — set to the authenticated voter's email when they vote as proxy for a lot they do not own; NULL when voting for own lot
- [ ] Typecheck/lint passes

---

### US-PX02: Import proxy nominations via CSV/Excel

**Status:** ✅ Implemented

**Description:** As a building manager, I want to upload a proxy nomination file so I can bulk-set proxy voters for lots without editing each lot individually.

**Acceptance Criteria:**

- [ ] Owners page in admin portal shows a new "Import Proxy Nominations" upload button, accepting `.csv` and `.xlsx`
- [ ] Required columns (case-insensitive): `Lot#`, `Proxy Email`; optional columns: `proxy_given_name`, `proxy_surname`
- [ ] Extra columns are silently ignored
- [ ] Each row upserts the proxy for that lot (identified by `lot_number` within building)
- [ ] A row with a blank `Proxy Email` removes the proxy nomination for that lot (deletes the `lot_proxy` record if it exists)
- [ ] Lots not present in the file are unaffected (not removed)
- [ ] `Lot#` not found in the building → row is skipped with a warning in the response (not a fatal error)
- [ ] Missing required columns → 422 with clear error message
- [ ] Successful import response: `{ "upserted": N, "removed": N, "skipped": N }`
- [ ] Typecheck/lint passes

---

### US-PX03: Import lot financial positions via CSV/Excel

**Status:** ✅ Implemented

**Description:** As a building manager, I want to upload a financial position file so I can bulk-update lot arrear status without re-importing the full lot owner list.

**Acceptance Criteria:**

- [ ] Owners page shows a new "Import Financial Positions" upload button, accepting `.csv` and `.xlsx`
- [ ] Required columns (case-insensitive): `Lot#`, `Financial Position`
- [ ] Accepted values for `Financial Position` (case-insensitive): `Normal`, `In Arrear` — mapped to `'normal'` and `'in_arrear'`
- [ ] Each row updates `lot_owners.financial_position` for the matching `lot_number` within the building
- [ ] Lots not present in the file are unaffected
- [ ] `Lot#` not found in the building → row is skipped with a warning (not a fatal error)
- [ ] Invalid `Financial Position` value → 422 with clear error message listing the offending rows
- [ ] Missing required columns → 422
- [ ] Successful import response: `{ "updated": N, "skipped": N }`
- [ ] Typecheck/lint passes

---

### US-PX07: Admin lot owner detail shows proxy

**Status:** ✅ Implemented

**Description:** As a building manager, I want to see the proxy nomination on the lot owner detail page so I know who is authorised to vote on behalf of that lot.

**Acceptance Criteria:**

- [ ] Lot owner detail page (admin) shows a "Proxy" field
- [ ] If a proxy is nominated: display the proxy email address (and name if set)
- [ ] If no proxy is nominated: display "None" or leave the field blank
- [ ] `GET /api/admin/lot-owners/{id}` response includes `proxy_email: string | null` and proxy name fields
- [ ] Typecheck/lint passes

---

### US-PX08: Edit proxy nomination inline on lot owner edit screen

**Status:** ✅ Implemented

**Description:** As a building manager, I want to set or remove the proxy for an individual lot owner directly from the edit modal, without needing to prepare and upload a CSV file.

**Acceptance Criteria:**

- [ ] The lot owner edit modal shows a "Proxy" section
- [ ] If a proxy is nominated: display the current proxy email (and name if set) with a "Remove proxy" button
- [ ] If no proxy is nominated: display inputs (given name, surname, email) and "Set proxy" button to nominate one
- [ ] Entering an invalid email and clicking "Set proxy" shows a validation error without making an API call
- [ ] A successful "Set proxy" call immediately reflects the new proxy email in the modal
- [ ] A successful "Remove proxy" call immediately clears the proxy email display
- [ ] Server errors (4xx/5xx) are displayed inline below the proxy section
- [ ] `PUT /api/admin/lot-owners/{id}/proxy` with body `{ "proxy_email": "<email>", "given_name"?: string, "surname"?: string }` — creates or replaces the proxy; returns `LotOwnerOut`
- [ ] `DELETE /api/admin/lot-owners/{id}/proxy` — removes the proxy; returns `LotOwnerOut`; 404 if no proxy set
- [ ] Typecheck/lint passes

---

### US-BO-01: Associate a named owner with each email address on a lot

**Status:** ✅ Implemented

**Description:** As a building manager, I want each email address on a lot to have a person's name (given name and surname) associated with it, so I can clearly identify which individual owner each contact email belongs to.

**Acceptance Criteria:**

- [ ] Each `LotOwnerEmail` record can store an optional `given_name` and `surname` alongside the email address
- [ ] The admin API response for a lot owner includes an `owner_emails` field: a list of objects each with `id`, `email`, `given_name`, `surname`
- [ ] The backward-compatible `emails` field (list of email strings) is still returned in API responses so existing integrations are not broken
- [ ] Existing lot owner email records that were created without names are valid; name fields default to `null`
- [ ] Schema migration adds `given_name` and `surname` nullable columns to `lot_owner_emails`
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-BO-02: Admin can add, edit, and remove named owner email entries in the building edit UI

**Status:** ✅ Implemented

**Description:** As a building manager, I want to manage the individual owner contact entries for a lot (each with a name and email) directly in the building edit UI.

**Acceptance Criteria:**

- [ ] The lot owner edit modal displays each owner email entry as a row showing: given name + surname (or "— no name —" if not set) and email address
- [ ] Each row has an "Edit" action that opens an inline edit sub-form pre-filled with the current given name, surname, and email; "Save" updates the entry via `PATCH /api/admin/lot-owners/{id}/owner-emails/{emailId}`
- [ ] Each row has a "Remove" action that deletes the entry via `DELETE /api/admin/lot-owners/{id}/owner-emails/{emailId}` (uses the UUID, not email string)
- [ ] An "Add owner" sub-form at the bottom of the list has fields for given name (optional), surname (optional), and email (required); submitting calls `POST /api/admin/lot-owners/{id}/owner-emails`
- [ ] Adding a duplicate email (already exists on this lot) shows an inline error and does not create a duplicate entry
- [ ] `PATCH /api/admin/lot-owners/{id}/owner-emails/{emailId}` accepts any subset of `{email, given_name, surname}`; at least one field required (422 otherwise)
- [ ] `DELETE /api/admin/lot-owners/{id}/owner-emails/{emailId}` returns 204; returns 404 if the email record does not exist or does not belong to the given lot
- [ ] `POST /api/admin/lot-owners/{id}/owner-emails` returns 201; returns 409 if the email already exists on this lot
- [ ] Existing `POST /lot-owners/{id}/emails` and `DELETE /lot-owners/{id}/emails/{email}` endpoints continue to work unchanged
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-BO-03: Proxy management retains name + email pattern

**Status:** ✅ Implemented

**Description:** As a building manager, I want proxy assignments to continue supporting a name and email for the proxy holder, consistent with the owner email model.

**Acceptance Criteria:**

- [ ] The existing proxy `PUT /api/admin/lot-owners/{id}/proxy` endpoint continues to accept `proxy_email`, `given_name`, and `surname`
- [ ] The lot owner edit modal proxy section shows proxy name and email
- [ ] Proxy name fields (`given_name`, `surname`) are displayed in the proxy row in the edit modal
- [ ] All existing proxy-related tests pass unchanged
- [ ] Typecheck/lint passes

---

### US-LON-01: Lot owner given name and surname

**Status:** ✅ Implemented

**Description:** As an admin, I want to store a given name and surname for each lot owner so that admin views and reports can identify owners by name rather than lot number alone.

**Acceptance Criteria:**

- [x] `LotOwner` gains two optional fields: `given_name` (VARCHAR, nullable) and `surname` (VARCHAR, nullable)
- [x] The Add Lot Owner form in the admin building detail page includes optional "Given name" and "Surname" fields
- [x] The Edit Lot Owner modal pre-fills existing name values and allows updates
- [x] The lot owner table on the admin building detail page shows a "Name" column (blank when not set)
- [x] Names are not shown anywhere in the voter-facing flow
- [x] The lot owner import (CSV/Excel) accepts optional `given_name` and `surname` columns; rows without these columns import successfully without error (names default to null)
- [x] `PATCH /api/admin/lot-owners/{id}` accepts `given_name` and `surname` in the request body
- [x] `GET /api/admin/buildings/{id}/lot-owners` includes `given_name` and `surname` in each `LotOwnerOut` item
- [x] All tests pass at 100% coverage
- [x] Typecheck/lint passes

---

### US-LON-02: Proxy contact name

**Status:** ✅ Implemented

**Description:** As an admin, I want to store a name for the proxy contact on a lot so that the results report and admin views can identify proxy representatives by name.

**Acceptance Criteria:**

- [x] `LotProxy` gains two optional fields: `given_name` (VARCHAR, nullable) and `surname` (VARCHAR, nullable)
- [x] The Set Proxy dialog on the lot owner detail / edit view includes optional "Given name" and "Surname" fields for the proxy contact
- [x] `PUT /api/admin/lot-owners/{id}/proxy` accepts `given_name` and `surname` alongside `proxy_email`
- [x] `GET /api/admin/lot-owners/{id}` returns proxy name fields in the `LotOwnerOut.proxy` object
- [x] The proxy import (CSV/Excel) accepts optional `proxy_given_name` and `proxy_surname` columns; rows without them import without error
- [x] Proxy names are not shown in the voter-facing flow
- [x] All tests pass at 100% coverage
- [x] Typecheck/lint passes

---

### US-SORT-01: Sortable admin table columns

**Status:** ✅ Implemented

**Description:** As an admin, I want to sort the buildings, meetings, and lot owners tables by clicking column headers, so that I can find records quickly.

**Acceptance Criteria:**

- [ ] Buildings table column headers "Name" and "Created At" are clickable and trigger server-side sorting
- [ ] Meetings table column headers "Title" and "Created At" are clickable and trigger server-side sorting
- [ ] Lot owners table column headers "Lot Number", "Unit Entitlement", and "Financial Position" are sortable client-side
- [ ] `GET /api/admin/buildings` accepts optional `sort_by` (`"name"` | `"created_at"`) and `sort_dir` (`"asc"` | `"desc"`) query parameters; invalid values return 422
- [ ] `GET /api/admin/general-meetings` accepts the same `sort_by` (`"title"` | `"created_at"`) and `sort_dir` parameters; invalid values return 422
- [ ] Sort state for buildings and meetings is persisted in URL search params (`sort_by`, `sort_dir`) so it survives page refresh and back navigation
- [ ] Changing the sort column or direction resets pagination to page 1
- [ ] Active sort column shows a directional indicator (▲ ascending, ▼ descending); inactive sortable columns show a neutral ⇅ indicator
- [ ] Every sortable `<th>` has an `aria-sort` attribute; non-sortable `<th>` elements do not have `aria-sort`
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-FIX11-A: Remove redundant top-level name fields from lot owner edit forms

**Status:** ✅ Implemented — branch: `fix/proxy-names`, committed 2026-04-12

**Description:** As a building manager, I want the lot owner edit and add modals to stop showing separate "Given Name" and "Surname" inputs for the lot-level record, so the UI does not confuse lot-level names with the per-owner-email names that are the authoritative source of identity.

**Acceptance Criteria:**

- [ ] The `EditModal` no longer renders "Given Name (optional)" and "Surname (optional)" inputs for the top-level `LotOwner` record in its edit form section
- [ ] The `AddForm` no longer renders "Given Name (optional)" and "Surname (optional)" inputs for the top-level `LotOwner` record
- [ ] Removing these inputs does not remove the underlying `given_name`/`surname` columns from `lot_owners` — those remain in the DB and are still returned in API responses (backward-compatible)
- [ ] No regression in the per-owner-email name fields (the "Owners (name + email)" section is unchanged)
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-FIX11-B: Display and collect proxy names in the lot owner edit modal

**Status:** ✅ Implemented — branch: `fix/proxy-names`, committed 2026-04-12

**Description:** As a building manager, I want the proxy section of the lot owner edit modal to show the proxy holder's name alongside their email (when a name is stored), and to let me enter a name when setting a new proxy, so proxy contacts are identified by name rather than email alone.

**Acceptance Criteria:**

- [ ] When no proxy is set, the "Set proxy" section shows: "Proxy given name" text input (optional), "Proxy surname" text input (optional), email input (required), and a "Set proxy" button — matching the "Add owner" section layout
- [ ] When a proxy is set with names, the proxy display row shows: `Given Surname email@domain.com` + "Remove proxy" button
- [ ] When a proxy is set without names, the proxy display row shows: `— no name —` followed by the proxy email + "Remove proxy" button
- [ ] Clicking "Set proxy" with blank name fields is valid — names are optional; `null` is stored for both
- [ ] Setting a proxy correctly passes `given_name` and `surname` (or `null`) to `PUT /api/admin/lot-owners/{id}/proxy`
- [ ] After a successful "Set proxy", the modal proxy section immediately reflects the new name + email
- [ ] After a successful "Remove proxy", the modal reverts to the three-input "Set proxy" form (given name, surname, email)
- [ ] `GET /api/admin/buildings/{id}/lot-owners` and `GET /api/admin/lot-owners/{id}` return `proxy_given_name` and `proxy_surname` alongside `proxy_email` in `LotOwnerOut`
- [ ] The lot owner table's "Proxy" column shows `Name (email)` when the proxy has a name, or just the email when no name is stored
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-UX-01: Mobile and form usability fixes

**Status:** ✅ Implemented

**Description:** As an admin or voter, I want the interface to work correctly on mobile devices and validate email inputs consistently.

**Acceptance Criteria:**

- [ ] On the Buildings admin page, the "Show archived" toggle and "+ New Building" button wrap to the next line on narrow viewports (≤ 375 px) instead of overflowing
- [ ] The Sign out button renders in white/off-white on both mobile (inside the nav drawer) and desktop (inside the sidebar)
- [ ] The Add Lot Owner form validates email format on submit with the inline error "Please enter a valid email address." and prevents the API call
- [ ] The New Building modal validates manager email format on submit with the same inline error
- [ ] Empty email in the Add Lot Owner form is separately permitted (see US-LOE-01)
- [ ] Email format validation uses the shared `isValidEmail` utility consistently across all admin forms
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-UI-FIX-09: Admin buildings list has a name search filter

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As an admin, I want to filter the buildings list by name so I can quickly find a specific building when there are many in the system.

**Acceptance Criteria:**

- [ ] A text filter input labelled "Search buildings" appears in the buildings list page header row (alongside the "Show archived" toggle)
- [ ] Typing in the filter narrows the list to buildings whose names contain the typed text (case-insensitive, server-side)
- [ ] The filter value is debounced (≥ 300ms) before triggering a new API request
- [ ] Changing the filter resets pagination to page 1
- [ ] The filter state is persisted in the URL as a `name` search param so it survives page refresh and back navigation
- [ ] Clearing the filter removes the `name` param from the URL and shows the full (or archived-toggled) list
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-10: Admin lot owner table shows named owner alongside each email

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As a building manager, I want to see each email address displayed alongside its associated owner name in the lot owner table so I can identify which person each email belongs to at a glance.

**Acceptance Criteria:**

- [ ] In the admin lot owner table (building detail page), the Email column renders each `owner_emails` entry on its own line in the format: `Given Surname <email@example.com>` when a name is available
- [ ] When an email entry has no given name or surname, only the email address is shown (no angle-bracket wrapper)
- [ ] Multiple email entries for the same lot each appear on their own line
- [ ] The Name column (showing `LotOwner.given_name` / `LotOwner.surname`) is unchanged
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

## Functional Requirements

- FR-1: A building record contains: name, manager email address, and associated lot owner records. Buildings can be created individually via a form or bulk-created/updated via CSV or Excel upload. Building names must be globally unique (case-insensitive).
- FR-3: A lot owner record contains: building ID, lot number (string), unit entitlement (non-negative integer), financial position (`normal` | `in_arrear`), optional given name and surname. Lot number must be unique per building. Multiple lots may share the same email address within a building (multi-lot owners). Lot owner records cannot be deleted — only created or edited.
- FR-6: Import for lot owners accepts CSV or Excel (.xlsx / .xls). Import performs a full replacement of existing records for the building. Changes do not affect the weight snapshot of any already-open meeting.
- FR-V2: `LotOwner.financial_position` is a non-nullable enum: `'normal'` | `'in_arrear'`. Default is `'normal'`. Can be updated via import, manual edit, or admin form.
- FR-V3: A new `lot_owner_emails` table stores zero or more email addresses per lot. Authentication looks up voters by email in `lot_owner_emails`, not in `lot_owners`.
- Proxy nominations are building-scoped and apply to all meetings for that building until removed. One proxy per lot at a time.
- `financial_position_snapshot` on `GeneralMeetingLotWeight` is captured at meeting creation time and is unaffected by subsequent imports.

---

## Non-Goals

- No PropertyIQ sync changes
- No per-lot different vote choices within the same submission — all lots selected in one submission receive the same votes
- No public-facing display of financial position to other voters
- No automatic promotion from 'in_arrear' to 'normal' based on payment data
- No email notifications to proxy voters when they are nominated
