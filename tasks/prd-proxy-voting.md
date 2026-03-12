# PRD: Proxy Voting

## Introduction

Allow lot owners to nominate a proxy to vote on their behalf at an AGM. A proxy may have a different email address from the lot owner and may vote for multiple lots (their own and any lots they are nominated to represent). Proxy nominations are stored at the building level and apply to all AGMs for that building until changed or removed. This feature also adds standalone CSV/Excel uploads for proxy nominations and lot financial positions, giving admins a fast way to bulk-update these fields without re-importing the full lot owner list.

---

## Goals

- Enable proxy voters to authenticate with their own email and vote on behalf of nominated lots
- Store proxy nominations at the building level with simple admin tooling for bulk upload
- In-arrear voting restrictions follow the lot, not the proxy voter
- Maintain an audit trail in the DB (not exposed in UI) of which votes were cast by proxy
- Allow admins to update lot financial positions via a dedicated import, separate from the full lot owner import

---

## User Stories

### US-PX01: Proxy nomination data model

**Description:** As a developer, I need a `lot_proxy` table so proxy nominations can be stored and queried at the building level.

**Acceptance Criteria:**
- [ ] New table `lot_proxy`: `id` (UUID PK), `lot_owner_id` (FK → `lot_owners.id` CASCADE DELETE, UNIQUE), `proxy_email` (String NOT NULL), `created_at` (datetime)
- [ ] Unique constraint on `lot_owner_id` — one proxy per lot at a time
- [ ] Index on `proxy_email` for fast lookup during authentication
- [ ] Migration generated and runs cleanly against dev and test DBs
- [ ] Existing data is unaffected by migration
- [ ] `BallotSubmission` gains a nullable `proxy_email` (String) column — set to the authenticated voter's email when they vote as proxy for a lot they do not own; NULL when voting for own lot
- [ ] Migration for `BallotSubmission.proxy_email` generated and runs cleanly
- [ ] Typecheck/lint passes

---

### US-PX02: Import proxy nominations via CSV/Excel

**Description:** As a building manager, I want to upload a proxy nomination file so I can bulk-set proxy voters for lots without editing each lot individually.

**Acceptance Criteria:**
- [ ] Owners page in admin portal shows a new "Import Proxy Nominations" upload button, accepting `.csv` and `.xlsx`
- [ ] Required columns (case-insensitive): `Lot#`, `Proxy Email`
- [ ] Extra columns are silently ignored
- [ ] Each row upserts the proxy for that lot (identified by `lot_number` within building): creates a new `lot_proxy` record or updates the existing one
- [ ] A row with a blank `Proxy Email` removes the proxy nomination for that lot (deletes the `lot_proxy` record if it exists)
- [ ] Lots not present in the file are unaffected (not removed)
- [ ] `Lot#` not found in the building → row is skipped with a warning in the response (not a fatal error)
- [ ] Missing required columns → 422 with clear error message
- [ ] Invalid file → 422
- [ ] Successful import response: `{ "upserted": N, "removed": N, "skipped": N }`
- [ ] Typecheck/lint passes

---

### US-PX03: Import lot financial positions via CSV/Excel

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

### US-PX04: Authentication resolves proxy lots

**Description:** As a proxy voter, I want to log in with my own email and see both my own lots and the lots I am nominated to vote for.

**Acceptance Criteria:**
- [ ] `POST /api/auth/verify` looks up `LotOwnerEmail` records matching `email` + `building_id` (existing) AND `lot_proxy` records where `proxy_email = email` for lots in the same building
- [ ] Both sets are merged into the `lots` response array; duplicates (where proxy voter also owns the lot) are deduplicated — the lot appears once with `is_proxy: false`
- [ ] Each lot entry in the response includes a new `is_proxy: bool` field — `true` if the email is a nominated proxy for that lot, `false` if the voter owns the lot directly
- [ ] If the voter's email appears only as a proxy (owns no lots in the building), auth succeeds as long as at least one proxy nomination exists for that building
- [ ] If the voter's email appears neither as an owner nor a proxy, return 401 with message "Email address not found for this building"
- [ ] `already_submitted` per lot is unchanged — checks `BallotSubmission` for `lot_owner_id + agm_id`
- [ ] Typecheck/lint passes

---

### US-PX05: Lot selection UI shows proxy label

**Description:** As a proxy voter, I want to see which lots are mine and which I am voting for as proxy, so I can make informed selections.

**Acceptance Criteria:**
- [ ] Lot selection screen shows all lots (own + proxied) in a single flat list
- [ ] Own lots show no extra label (or a subtle "Your lot" label — designer's choice)
- [ ] Proxied lots show a clear "Proxy" badge or label (e.g. "Proxy for Lot 42")
- [ ] In-arrear badge still shown per lot regardless of proxy status
- [ ] Already-submitted lots remain greyed out and non-interactive, with their proxy/own label still visible
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-PX06: Proxy audit trail on ballot submission

**Description:** As a developer, I need to record which ballots were cast by proxy so there is an audit trail in the database.

**Acceptance Criteria:**
- [ ] When `POST /api/agm/{id}/vote` is called, for each `lot_owner_id` in the request:
  - If the authenticated `voter_email` matches a `LotOwnerEmail` for that lot → `BallotSubmission.proxy_email = NULL`
  - If the authenticated `voter_email` matches `lot_proxy.proxy_email` for that lot → `BallotSubmission.proxy_email = voter_email`
- [ ] 403 if the authenticated voter's email is neither an owner email nor a proxy email for a submitted `lot_owner_id`
- [ ] `proxy_email` is stored in the DB but not exposed in any API response or UI
- [ ] Typecheck/lint passes

---

### US-PX07: Admin lot owner detail shows proxy

**Description:** As a building manager, I want to see the proxy nomination on the lot owner detail page so I know who is authorised to vote on behalf of that lot.

**Acceptance Criteria:**
- [ ] Lot owner detail page (admin) shows a "Proxy" field
- [ ] If a proxy is nominated: display the proxy email address
- [ ] If no proxy is nominated: display "None" or leave the field blank
- [ ] `GET /api/admin/lot-owners/{id}` response includes `proxy_email: string | null`
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

## Functional Requirements

- FR-1: One proxy per lot at a time; setting a new proxy replaces the existing one
- FR-2: Proxy nominations are building-scoped and apply to all AGMs for that building until removed
- FR-3: In-arrear restrictions follow the lot — a proxy can only vote on Special Motions for an in-arrear lot, regardless of their own financial position
- FR-4: A proxy voter who also owns lots in the same building sees all lots (own + proxied) in one list
- FR-5: A proxy voter who owns no lots in the building can still authenticate, provided they have at least one active proxy nomination
- FR-6: Proxy nominations import upserts by `lot_number` within building; blank `Proxy Email` removes the nomination
- FR-7: Financial position import updates `lot_owners.financial_position` by `lot_number` within building; lots absent from the file are unaffected
- FR-8: `BallotSubmission.proxy_email` is set when a proxy submits a vote; NULL when the lot owner votes directly
- FR-9: Lots not found in the building during import are skipped with a warning, not a fatal error
- FR-10: The `AGMLotWeight` snapshot is unaffected by proxy nominations — proxy is a runtime auth concern only

---

## Non-Goals

- No UI for adding/editing a single proxy nomination on the lot owner detail page — bulk import only (US-PX02)
- No proxy approval workflow — nominations take effect immediately on import
- No per-AGM proxy scoping — nominations are building-level
- No email notifications to proxy voters when they are nominated
- No restriction on who can be a proxy (any email address is valid, including non-lot-owners)
- Proxy audit data (`BallotSubmission.proxy_email`) is not exposed in the admin results UI or reports

---

## Technical Considerations

- `lot_proxy` is a simple join-like table but with a unique constraint on `lot_owner_id` (not a many-to-many)
- Authentication query must union two sources: `LotOwnerEmail JOIN lot_owners` (direct) + `lot_proxy JOIN lot_owners` (proxy) — filter both by `building_id`
- Deduplication: if a voter's email appears in both sets for the same lot, treat as direct (`is_proxy: false`)
- `financial_position_snapshot` on `AGMLotWeight` is captured at AGM creation time and is unaffected by the financial position import — the import only updates `lot_owners.financial_position` for future AGMs
- The financial position import reuses the same upsert pattern as the lot owner import but operates on a subset of columns

---

## Success Metrics

- A proxy voter can authenticate and vote for proxied lots without any manual admin intervention beyond uploading the nomination file
- Admins can update financial positions for all lots in a building with a single file upload
- Zero change to the vote tally logic — in-arrear restrictions and entitlement weighting are unaffected by proxy

---

## Open Questions

_All resolved._

- **Lot owner name on proxy label:** No — lot owner names are not stored and will not be added. Proxied lots show lot number only (e.g. "Proxy for Lot 42").
- **Proxy removed mid-session:** The in-flight session remains valid and the vote is accepted. Proxy authorisation is checked at authentication time only, not at vote submission time.
