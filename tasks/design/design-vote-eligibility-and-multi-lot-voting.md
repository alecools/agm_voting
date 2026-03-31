# Technical Design: Vote Eligibility and Multi-Lot Voting

**Status:** Implemented

## Overview

This feature redesigns the AGM voting model from a single-email-per-lot, single-ballot-per-email system into a per-lot ballot system that supports multiple email addresses per lot, financial position tracking, and motion-type-based eligibility enforcement. The key motivations were:

- Multiple people may legitimately share one lot (co-owners with different emails)
- Lot owners with many lots need to vote for subsets across sessions
- In-arrear lots are legally restricted from voting on General Motions

The implementation adds three new database columns/tables (`LotOwnerEmail`, `financial_position` on `LotOwner`, `financial_position_snapshot` on `GeneralMeetingLotWeight`), removes `email` from `LotOwner` and `voter_email` from `GeneralMeetingLotWeight`, adds `motion_type` to `Motion`, adds `lot_owner_id` as the uniqueness key on `BallotSubmission`, adds `not_eligible` to `VoteChoice`, and updates auth, vote submission, drafts, and the confirmation screen accordingly.

---

## Database Changes

### New table: `lot_owner_emails`

Replaces the `email` column that previously lived on `lot_owners`. Zero or more rows per lot owner.

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK, default `uuid4` |
| `lot_owner_id` | UUID | FK → `lot_owners.id` ON DELETE CASCADE, NOT NULL |
| `email` | String | nullable |

- Unique constraint on `(lot_owner_id, email)` — named `uq_lot_owner_emails_owner_email`. Two NULLs are permitted (SQL NULL inequality).
- Index on `email` — named `ix_lot_owner_emails_email` — for fast lookup during authentication.

### Modified table: `lot_owners`

- `email` column **removed**.
- New column `financial_position`: `Enum(FinancialPosition)`, NOT NULL, default/server_default `'normal'`.
  - Enum values: `normal`, `in_arrear` (Python: `FinancialPosition`).

### Modified table: `general_meeting_lot_weights`

- `voter_email` column **removed**.
- New column `financial_position_snapshot`: `Enum(FinancialPositionSnapshot)`, NOT NULL, default/server_default `'normal'`.
  - Enum values: `normal`, `in_arrear` (Python: `FinancialPositionSnapshot` — a separate enum from `FinancialPosition` even though the values are identical).

### Modified table: `ballot_submissions`

- New column `lot_owner_id`: UUID, FK → `lot_owners.id` ON DELETE CASCADE, NOT NULL.
- Unique constraint changed from `(general_meeting_id, voter_email)` to `(general_meeting_id, lot_owner_id)` — named `uq_ballot_submissions_gm_lot_owner`.
- `voter_email` column retained (NOT NULL, String) for audit purposes only; no longer the uniqueness key.
- `proxy_email` column retained (nullable String) — set when the submitting email is a proxy, not a direct owner.

### Modified table: `votes`

- New column `lot_owner_id`: UUID, FK → `lot_owners.id` ON DELETE SET NULL, **nullable** (legacy rows have NULL).
- Unique constraint changed to `(general_meeting_id, motion_id, lot_owner_id)` — named `uq_votes_gm_motion_lot_owner`.
- `voter_email` column retained (NOT NULL, String) — still set on every vote row for legacy compatibility.
- `VoteChoice` enum gains new value: `not_eligible`.

### Modified table: `motions`

- New column `motion_type`: `Enum(MotionType)`, NOT NULL, default/server_default `'general'`.
  - Enum values: `general`, `special` (Python: `MotionType`).

---

## Backend Changes

### New/Modified Models

**`LotOwnerEmail`** (`backend/app/models/lot_owner_email.py`) — new model:
```python
class LotOwnerEmail(Base):
    __tablename__ = "lot_owner_emails"
    id: Mapped[uuid.UUID]
    lot_owner_id: Mapped[uuid.UUID]  # FK → lot_owners.id CASCADE
    email: Mapped[str | None]
```

**`LotOwner`** (`backend/app/models/lot_owner.py`) — modified:
- `email` removed
- `financial_position: Mapped[FinancialPosition]` added — enum, NOT NULL, default `normal`
- `emails` relationship added: `Mapped[list["LotOwnerEmail"]]`
- `ballot_submissions` relationship added: `Mapped[list["BallotSubmission"]]`

**`GeneralMeetingLotWeight`** (`backend/app/models/general_meeting_lot_weight.py`) — modified:
- `voter_email` removed
- `financial_position_snapshot: Mapped[FinancialPositionSnapshot]` added — enum, NOT NULL, default `normal`

**`BallotSubmission`** (`backend/app/models/ballot_submission.py`) — modified:
- `lot_owner_id: Mapped[uuid.UUID]` added — FK → `lot_owners.id` CASCADE, NOT NULL
- Unique constraint now on `(general_meeting_id, lot_owner_id)`
- `voter_email` retained for audit
- `lot_owner` relationship added

**`Vote`** (`backend/app/models/vote.py`) — modified:
- `lot_owner_id: Mapped[uuid.UUID | None]` added — FK → `lot_owners.id` SET NULL, nullable
- Unique constraint now on `(general_meeting_id, motion_id, lot_owner_id)`
- `VoteChoice` enum gains `not_eligible = "not_eligible"`

**`Motion`** (`backend/app/models/motion.py`) — modified:
- `motion_type: Mapped[MotionType]` added — enum, NOT NULL, server_default `'general'`

### New/Modified API Endpoints

#### `POST /api/auth/request-otp`

Request: `{ email: str, general_meeting_id: UUID }`

Changed: email lookup now queries `lot_owner_emails` (joined to `lot_owners`) instead of `lot_owners.email`. Also checks `lot_proxy.proxy_email`. Returns `{ sent: true }` always (enumeration-safe).

#### `POST /api/auth/verify`

Request: `{ email: str, general_meeting_id: UUID, code: str }`

Note: `building_id` is **not** in the request body — it is derived from the `GeneralMeeting` record. `lot_number` has been removed from the request.

Response:
```json
{
  "lots": [
    {
      "lot_owner_id": "UUID",
      "lot_number": "string",
      "financial_position": "normal" | "in_arrear",
      "already_submitted": true | false,
      "is_proxy": true | false
    }
  ],
  "voter_email": "string",
  "agm_status": "open" | "closed" | "pending",
  "building_name": "string",
  "meeting_title": "string"
}
```

Changed behaviour:
- Looks up `LotOwnerEmail` records matching `email` for the derived `building_id`, then resolves `LotOwner` records.
- Also looks up `LotProxy` records where `proxy_email = email` for the same building — proxy lots are included with `is_proxy: true`.
- Returns 401 if no matching lots found (direct or proxy).
- `already_submitted` is computed per `lot_owner_id` by checking `BallotSubmission` records.
- Lots are sorted by `lot_number` for consistent ordering.
- Session is still scoped to `voter_email + building_id + general_meeting_id` (no change to `create_session`).

#### `GET /api/general-meeting/{id}/motions`

Response now includes `motion_type: "general" | "special"` on each motion item.

#### `PUT /api/general-meeting/{id}/draft`

Request body unchanged except `lot_owner_id` (optional UUID) is now accepted and passed through to `save_draft`. Draft votes are stored with `lot_owner_id` when provided, enabling per-lot draft state.

#### `GET /api/general-meeting/{id}/drafts`

Query parameter `lot_owner_id` (optional UUID) added. When provided, returns only draft votes for that lot owner.

#### `POST /api/general-meeting/{id}/submit`

Request:
```json
{
  "lot_owner_ids": ["UUID", ...],
  "votes": [{ "motion_id": "UUID", "choice": "yes|no|abstained" }, ...]
}
```

Response:
```json
{
  "submitted": true,
  "lots": [
    {
      "lot_owner_id": "UUID",
      "lot_number": "string",
      "votes": [{ "motion_id": "UUID", "motion_title": "string", "choice": "string" }]
    }
  ]
}
```

#### `GET /api/general-meeting/{id}/my-ballot`

Response:
```json
{
  "voter_email": "string",
  "meeting_title": "string",
  "building_name": "string",
  "submitted_lots": [
    {
      "lot_owner_id": "UUID",
      "lot_number": "string",
      "financial_position": "normal" | "in_arrear",
      "votes": [
        {
          "motion_id": "UUID",
          "motion_title": "string",
          "order_index": 0,
          "choice": "yes|no|abstained|not_eligible",
          "eligible": true | false
        }
      ]
    }
  ],
  "remaining_lot_owner_ids": ["UUID", ...]
}
```

`remaining_lot_owner_ids` lists all lot owner IDs accessible to this voter's email (direct + proxy) that have not yet submitted, enabling the frontend to show a "vote for remaining lots" flow.

#### `POST /api/admin/buildings/{id}/lot-owners/import`

Unchanged endpoint path. Behaviour extended:
- Multiple rows with the same `Lot#` create one lot with multiple `LotOwnerEmail` records.
- Blank `Email` column: lot is created/updated but no `LotOwnerEmail` row is inserted.
- `Financial Position` column accepted (case-insensitive); values `Normal`, `In Arrear`, `in_arrear`; blank defaults to `normal`.
- On upsert: existing `LotOwnerEmail` rows for the lot are deleted and replaced with the new set from the import file.
- Returns `{ "imported": int, "emails": int }`.

#### `POST /api/admin/buildings/{id}/import-financial-positions` (new)

Accepts CSV or Excel file. Auto-detects two formats:
- **Simple template**: first cell is `Lot#`, must have `Financial Position` column.
- **TOCS Lot Positions Report**: multi-section format with fund headers and `Closing Balance` column. Positive closing balance → `in_arrear`; zero/negative/credit → `normal`. Worst-case logic across multiple fund sections.

Returns `{ "updated": int, "skipped": int }`.

#### Admin lot owner endpoints (modified)

`LotOwnerOut` now returns:
```json
{
  "id": "UUID",
  "lot_number": "string",
  "emails": ["string", ...],
  "unit_entitlement": 0,
  "financial_position": "normal" | "in_arrear",
  "proxy_email": "string | null"
}
```

New endpoints:
- `POST /api/admin/lot-owners/{id}/emails` — add an email to a lot owner (`AddEmailRequest: { email: str }`). Returns 409 if email already exists for the lot.
- `DELETE /api/admin/lot-owners/{id}/emails/{email}` — remove an email from a lot owner.
- `PUT /api/admin/lot-owners/{id}/proxy` — set/replace proxy nomination (`SetProxyRequest: { proxy_email: str }`).
- `DELETE /api/admin/lot-owners/{id}/proxy` — remove proxy nomination.

`PUT /api/admin/lot-owners/{id}` (`LotOwnerUpdate`) now accepts `financial_position` field.

#### Admin meeting detail / tally (modified)

`GET /api/admin/general-meetings/{id}` motion detail now includes `motion_type` and a `not_eligible` category in both `tally` and `voter_lists`:

```json
{
  "tally": {
    "yes": { "voter_count": 0, "entitlement_sum": 0 },
    "no": { ... },
    "abstained": { ... },
    "absent": { ... },
    "not_eligible": { ... }
  },
  "voter_lists": {
    "yes": [...],
    "no": [...],
    "abstained": [...],
    "absent": [...],
    "not_eligible": [...]
  }
}
```

Tallies are now computed by joining `ballot_submissions → votes → general_meeting_lot_weights` on `lot_owner_id`, summing `unit_entitlement_snapshot` per vote category. The legacy email-based grouping is removed.

### Service Logic

#### Authentication (`backend/app/routers/auth.py`)

`verify_auth` handler (not delegated to `auth_service`):
1. Fetch `GeneralMeeting` by `general_meeting_id` → derive `building_id`.
2. Validate OTP (mark used).
3. Query `LotOwnerEmail JOIN LotOwner` where `email = request.email AND building_id = building_id` → `direct_lot_owner_ids`.
4. Query `LotProxy JOIN LotOwner` where `proxy_email = request.email AND building_id = building_id` → `proxy_lot_owner_ids`.
5. Union both sets → `all_lot_owner_ids`. Return 401 if empty.
6. For each lot owner: compute `already_submitted` from `BallotSubmission` records; set `is_proxy = lot_owner_id not in direct_lot_owner_ids`.
7. Create session (unchanged).

#### Vote submission (`backend/app/services/voting_service.py`)

`submit_ballot` function:
1. Validate meeting is open.
2. For each `lot_owner_id` in `lot_owner_ids`: verify the authenticated `voter_email` is either a direct owner (via `LotOwnerEmail`) or a proxy (via `LotProxy`). Build `proxy_email_by_lot` dict for audit.
3. Check no `BallotSubmission` already exists for any of the submitted lots (all-or-nothing; 409 if any already submitted).
4. Fetch all `Motion` records and `GeneralMeetingLotWeight` records for the lots.
5. Delete existing draft `Vote` rows for the submitting lots (both per-lot and NULL-lot-owner-id drafts).
6. For each lot:
   - Determine `is_in_arrear` from `weight.financial_position_snapshot`.
   - For each motion:
     - If `is_in_arrear` and `motion.motion_type == MotionType.general` → record `not_eligible` (regardless of what the frontend sent).
     - Otherwise: use the `inline_votes` choice from the request if present; if absent → record `abstained`.
   - Insert `BallotSubmission` with `lot_owner_id`, `voter_email`, and `proxy_email` (if proxy).
7. Return `SubmitResponse` with per-lot ballot results.

#### AGM creation snapshot (`backend/app/services/admin_service.py`)

When creating a `GeneralMeeting`, `GeneralMeetingLotWeight` rows are created for every lot in the building. Each row now snapshots both `unit_entitlement_snapshot` and `financial_position_snapshot` from the live `LotOwner` values at creation time.

#### Financial position import (`backend/app/services/admin_service.py`)

`import_financial_positions(building_id, rows, db)`:
- For each row: look up `LotOwner` by `lot_number` within building.
- If not found: skip (increment `skipped`).
- If found: update `lot_owner.financial_position` and increment `updated`.
- Does NOT update `GeneralMeetingLotWeight.financial_position_snapshot` — the snapshot is fixed at AGM creation time.

`_parse_financial_position_csv_rows` auto-detects format:
- **Simple format**: first cell of first line is `Lot#` → parse as simple CSV with `Lot#` and `Financial Position` columns.
- **TOCS format**: otherwise → parse as TOCS Lot Positions Report with multiple fund sections, using `Closing Balance` to derive position. Worst-case across all fund sections (in arrear in any section → `in_arrear`).

#### Draft save/load (`backend/app/services/voting_service.py`)

`save_draft`: accepts optional `lot_owner_id`. When provided, draft Vote rows are keyed on `(general_meeting_id, motion_id, voter_email, lot_owner_id, status=draft)`.

`get_drafts`: accepts optional `lot_owner_id` filter. Returns draft votes for that lot owner only when specified.

#### My-ballot (`backend/app/services/voting_service.py`)

`get_my_ballot`:
- Resolves all lots for the voter email (direct + proxy) in the building.
- Computes `remaining_lot_owner_ids` = all lots not yet submitted.
- For each submitted lot:
  - Uses `financial_position_snapshot` from `GeneralMeetingLotWeight` to set `eligible: false` on General Motion votes for in-arrear lots.
  - Falls back to legacy NULL-lot-owner-id vote rows for backward compatibility with votes submitted before this feature was deployed.
- Returns `MyBallotResponse` with `submitted_lots` and `remaining_lot_owner_ids`.

---

## Frontend Changes

### New/Modified Components and Pages

#### `AuthPage` (`frontend/src/pages/vote/AuthPage.tsx`)

Changed: auth form no longer asks for lot number. On successful `verifyAuth`:
- Writes `meeting_lots_${meetingId}` to `sessionStorage` with pending lot IDs (for submit).
- Writes `meeting_lots_info_${meetingId}` with full `LotInfo[]` array (for lot panel in VotingPage).
- Writes `meeting_lot_info_${meetingId}` with pending lots only (for eligibility checks).
- Writes `meeting_building_name_${meetingId}` and `meeting_title_${meetingId}` for header display.
- Navigates directly to `/vote/${meetingId}/voting` (pending lots exist) or `/vote/${meetingId}/confirmation` (all submitted or closed).

Note: the PRD described a dedicated `LotSelectionPage`. This was **not implemented as a separate page**. Instead, lot selection is embedded as a sidebar panel within `VotingPage` for multi-lot voters.

#### `VotingPage` (`frontend/src/pages/vote/VotingPage.tsx`)

The lot selection UI is integrated into `VotingPage` as a desktop sidebar and a mobile drawer overlay, shown only for multi-lot voters (`allLots.length > 1`).

Lot panel behaviour:
- All pending (not-yet-submitted) lots are checked by default on mount (loaded from `meeting_lots_info_${meetingId}` in `sessionStorage`).
- Already-submitted lots show a disabled, checked-off checkbox with "Already submitted" badge.
- Each lot shows badges: "In Arrear" (amber) when `financial_position === "in_arrear"`, "via Proxy" when `is_proxy`, "Already submitted" when `already_submitted`.
- Shortcut buttons: Select All, Deselect All, Select Proxy Lots, Select Owned Lots (latter two only when proxy lots exist).
- When `selectedIds.size === 0` and Submit is clicked: show inline `<p role="alert">Please select at least one lot</p>`.
- When all lots are submitted: show "View Submission" button and hide "Submit ballot" button.

In-arrear banner:
- Computed from currently selected lots.
- `arrearBannerMode`: `"none"` | `"mixed"` | `"all"`.
- Rendered as `<div class="arrear-notice" data-testid="arrear-banner" role="note">`.
- "All" message: "All your selected lots are in arrear. You may only vote on Special Motions — General Motion votes will be recorded as not eligible."
- "Mixed" message: "Some of your selected lots are in arrear. Your votes on General Motions will not count for in-arrear lots — they will be recorded as not eligible. Votes for all other lots will be recorded normally."
- Banner updates immediately when checkboxes change.
- General Motion buttons are NOT disabled — frontend does not block submission.

On submit:
- For multi-lot voters: selected lot IDs are written to `sessionStorage['meeting_lots_${meetingId}']` and sent in `lot_owner_ids`.
- For single-lot voters: `meeting_lots_${meetingId}` was already written by `AuthPage` with the single pending lot ID.

Mobile: a drawer toggle button (`☰ Your Lots`) opens the lot panel as an overlay with a backdrop.

#### `ConfirmationPage` (`frontend/src/pages/vote/ConfirmationPage.tsx`)

Changed:
- Calls `GET /api/general-meeting/{id}/my-ballot` which returns per-lot ballot results.
- For multi-lot voters (`submitted_lots.length > 1`): renders votes grouped by lot number, each lot in its own `<li>` block.
- For single-lot voters: renders a flat list of vote items (existing behaviour).
- `not_eligible` choice renders as "Not eligible" (via `CHOICE_LABELS` map).
- `remaining_lot_owner_ids` is returned from the API but the "Vote for remaining lots" button is **not yet implemented** in the confirmation page — the page shows only submitted lots and a "Back to home" button.

### API Integration (`frontend/src/api/voter.ts`)

Key type changes:
- `AuthVerifyRequest`: `{ email, general_meeting_id, code }` — `lot_number` and `building_id` removed.
- `AuthVerifyResponse`: now includes `lots: LotInfo[]`, `building_name`, `meeting_title`.
- `LotInfo`: `{ lot_owner_id, lot_number, financial_position, already_submitted, is_proxy }`.
- `MotionOut`: now includes `motion_type: MotionType`.
- `SubmitBallotRequest`: `{ lot_owner_ids: string[], votes: Array<{ motion_id, choice }> }`.
- `SubmitResponse`: `{ submitted: boolean, lots: LotBallotResult[] }`.
- `MyBallotResponse`: includes `submitted_lots: LotBallotSummary[]` and `remaining_lot_owner_ids: string[]`.
- `LotBallotSummary`: `{ lot_owner_id, lot_number, financial_position, votes: BallotVoteItem[] }`.
- `BallotVoteItem`: `{ motion_id, motion_title, order_index, choice, eligible }`.

---

## Key Design Decisions

### `LotOwnerEmail` as a separate table (not an array column)

A separate table allows individual emails to be added/removed without rewriting the entire array, supports indexing for fast auth lookup, and maps cleanly to a cascade-delete FK. The nullable `email` column on `LotOwnerEmail` allows a lot to have a "placeholder" row without an actual address, though in practice blank-email rows from imports simply create no `LotOwnerEmail` row at all.

### Separate `FinancialPositionSnapshot` enum on `GeneralMeetingLotWeight`

The snapshot enum (`FinancialPositionSnapshot`) is defined separately from `LotOwner.financial_position` (`FinancialPosition`) even though both have identical values. This prevents accidental coupling: the snapshot is immutable once created and must not be affected by future changes to the source enum's allowed values.

### Per-lot `BallotSubmission` (not per-email)

Moving the uniqueness key to `(general_meeting_id, lot_owner_id)` means each lot votes exactly once regardless of which email authenticated. `voter_email` is kept as a non-unique audit column. This is backward-compatible for existing submissions since `voter_email` is still stored.

### `not_eligible` enforced at the backend, not the frontend

The frontend shows an informational banner and leaves all motion buttons interactive. The backend overrides any General Motion choice from an in-arrear lot with `not_eligible` at submission time, using `financial_position_snapshot` from `GeneralMeetingLotWeight` (not the live `LotOwner.financial_position`). This means financial position changes after AGM creation do not affect the AGM's eligibility rules.

### Lot selection embedded in VotingPage (not a separate route)

The PRD described a dedicated `LotSelectionPage`. The implementation integrates lot selection as a sidebar within `VotingPage` instead. This reduces page transitions and keeps lot context visible while voting.

### `remaining_lot_owner_ids` in `MyBallotResponse` (not yet fully wired up)

The backend computes and returns `remaining_lot_owner_ids` in the my-ballot response to support the partial-submission resume flow (US-V09). However, the ConfirmationPage frontend does not yet render a "Vote for remaining lots" button — this part of US-V09 was not implemented.

### OTP-based authentication replaces direct verify

The previous auth flow was a single `POST /api/auth/verify` with email + lot_number. The new flow is two steps: `POST /api/auth/request-otp` (sends OTP email), then `POST /api/auth/verify` (validates OTP + creates session). This is a separate change but lands in the same implementation — `lot_number` is removed from verify, and an `AuthOtp` table tracks issued codes.

---

## Data Flow

### Voter authenticates

1. Voter enters email on `AuthPage`.
2. Frontend calls `POST /api/auth/request-otp` with `{ email, general_meeting_id }`.
3. Backend looks up `LotOwnerEmail` and `LotProxy` records; if found, generates 8-char OTP, stores in `auth_otps`, sends email.
4. Voter enters OTP code.
5. Frontend calls `POST /api/auth/verify` with `{ email, general_meeting_id, code }`.
6. Backend validates OTP, derives `building_id` from meeting, resolves direct + proxy lots, checks per-lot `already_submitted`, creates session cookie.
7. Frontend stores lot info in `sessionStorage`, navigates to `/vote/${meetingId}/voting`.

### Voter selects lots and votes

1. `VotingPage` loads `meeting_lots_info_${meetingId}` from `sessionStorage`.
2. If multi-lot: sidebar shows all lots with checkboxes. Already-submitted lots are disabled.
3. Voter selects a subset of pending lots (default: all pending checked).
4. In-arrear banner appears if any selected lot has `financial_position === "in_arrear"`.
5. Voter answers motions (General Motion buttons remain interactive even for in-arrear lots).
6. Voter clicks "Submit ballot" → `SubmitDialog` confirms unanswered motions.
7. Frontend writes selected lot IDs to `sessionStorage['meeting_lots_${meetingId}']`.
8. Frontend calls `POST /api/general-meeting/{id}/submit` with `{ lot_owner_ids, votes }`.
9. Backend:
   - Verifies all `lot_owner_ids` belong to the voter (direct or proxy).
   - Checks no prior submission for any lot.
   - For each lot: overrides General Motion choices with `not_eligible` if `financial_position_snapshot == in_arrear`.
   - Inserts `BallotSubmission` + `Vote` rows per lot.
10. Frontend navigates to `/vote/${meetingId}/confirmation`.

### Voter views confirmation

1. `ConfirmationPage` calls `GET /api/general-meeting/{id}/my-ballot`.
2. Backend resolves all lots for the voter email (direct + proxy), finds submitted ballots, returns per-lot vote summaries.
3. For in-arrear lots: General Motion votes are shown with `eligible: false` and `choice: "not_eligible"` → rendered as "Not eligible".
4. Multi-lot: grouped by lot number. Single-lot: flat list.

### Admin views results

1. Admin calls `GET /api/admin/general-meetings/{id}` (meeting detail).
2. Backend computes per-motion tallies by joining `ballot_submissions → votes → general_meeting_lot_weights` on `lot_owner_id`.
3. `not_eligible` is a separate tally category (voter count + entitlement sum).
4. Each motion includes `motion_type: "general" | "special"`.
