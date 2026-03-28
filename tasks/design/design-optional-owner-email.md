# Design: Optional Lot Owner Email

## Overview

Currently every lot owner must have at least one email address. This blocks importing lot owners who do not have an email (e.g., estate-managed lots, deceased estates, or entities where no email is known). The feature makes email optional at every entry point: CSV/Excel import and the manual add-owner form.

A lot owner with no email simply has zero rows in the `lot_owner_emails` table. They cannot receive an OTP and cannot vote — they will always appear as absent at meeting close. This is an acceptable trade-off documented explicitly below.

---

## Current State

### Database

`LotOwner` has no `email` column itself. Emails are stored in `lot_owner_emails` (one row per address per owner). There is no DB-level constraint that forces at least one `lot_owner_emails` row per `lot_owner`. The constraint is purely in application logic.

`LotOwnerEmail` columns:
- `id` — UUID PK
- `lot_owner_id` — FK → `lot_owners.id` (CASCADE DELETE)
- `email` — VARCHAR, NOT NULL (individual row is never null, but rows are simply absent for email-less owners)

A `UNIQUE` constraint on `(building_id via join, email)` is enforced at the application layer via a check in `add_email_to_lot_owner` — duplicates within the same building are rejected. There is no DB-level partial unique index across buildings.

### Backend

**CSV import (`import_lot_owners_from_csv`)** — `email` column is optional in the file; a blank email cell is already silently skipped (line 576–579 in `admin_service.py`). The `email` column is not in `required_headers`. This means **CSV import already supports email-less owners at the service layer**. No code change is needed here.

**Excel import (`import_lot_owners_from_excel`)** — identical pattern: `email` column detected by index (`email_idx`), blank cells produce an empty string which is skipped. **Already supports email-less owners at the service layer**.

**`add_lot_owner` service** — `LotOwnerCreate.emails` is `list[str] = []` with a default of empty list. The loop in `add_lot_owner` already skips empty strings. **No service-layer change needed**.

**`LotOwnerCreate` schema** — `emails: list[str] = []` already accepts an empty list. However, the `AddForm` component in the frontend enforces `email` as required before calling the API, so an owner with no email can only be created if the frontend guard is removed.

### Frontend (`LotOwnerForm.tsx` — `AddForm` component)

Lines 469–476 in the current form:
```
if (!email.trim()) {
  setFormError("Email is required.");
  return;
}
if (!isValidEmail(email)) {
  setFormError("Please enter a valid email address.");
  return;
}
```

These two guards enforce email as a required field. They must be relaxed so that blank email is accepted and only a non-blank email is format-validated.

Additionally, the email input is type `"email"` which some browsers use to auto-validate. It should be changed to `type="text"` so the browser does not block empty submission.

### EditModal — minimum-email guard

Lines 186–190 of `LotOwnerForm.tsx`:
```
function handleRemoveEmail(email: string) {
  setEmailError(null);
  if (emails.length <= 1) {
    setEmailError("A lot owner must have at least one email address.");
    return;
  }
  removeEmailMutation.mutate(email);
}
```

This guard prevents removing the last email. With optional emails, removing the last email should be permitted. **This guard must be removed.**

---

## Proposed Changes

### Design Decision: Null rows vs. null column

Two approaches exist for representing "no email":

**Option A (chosen):** Lot owner has zero `lot_owner_emails` rows. This is already the natural representation — the table simply has no rows for the owner.

**Option B:** Add a nullable `email` column to `lot_owners` directly.

Option A is correct. The existing `lot_owner_emails` table was designed to support multiple emails per owner; the "no email" case maps to zero rows and requires no schema change. Option B would require a migration and add redundancy.

### Decision: Null emails and uniqueness

`LotOwnerEmail.email` rows are always non-null (each individual row is a real email string). Owners with no email simply have no rows. The uniqueness concern (multiple email-less owners in the same building) does not arise because there are no rows to conflict. **No constraint change is needed.**

---

## Changes Required

### 1. Backend — No service-layer changes needed

Both `import_lot_owners_from_csv` and `import_lot_owners_from_excel` already handle missing/blank emails by skipping the email insertion step. `add_lot_owner` likewise iterates over `data.emails` and skips blank strings. The `LotOwnerCreate` schema already has `emails: list[str] = []`.

**No backend service or schema changes are needed.**

### 2. Frontend — `AddForm` in `LotOwnerForm.tsx`

Three targeted changes inside the `AddForm` component:

**a. Remove the required-email guard**

Remove the block:
```
if (!email.trim()) {
  setFormError("Email is required.");
  return;
}
```

**b. Conditionalize the format check**

Change:
```
if (!isValidEmail(email)) {
  setFormError("Please enter a valid email address.");
  return;
}
```

To:
```
if (email.trim() && !isValidEmail(email)) {
  setFormError("Please enter a valid email address.");
  return;
}
```

**c. Change input type and add hint text**

Change `type="email"` to `type="text"` on the email input (prevents browser native validation blocking empty submission).

Add a hint below the email label:
```
<span className="field__hint">Leave blank if no email address</span>
```

Or as placeholder text: `placeholder="owner@example.com (optional)"`.

**d. Update the API call**

When email is blank, pass `emails: []` instead of `emails: [email]`:
```
emails: email.trim() ? [email.trim()] : [],
```

### 3. Frontend — `EditModal` in `LotOwnerForm.tsx`

**Remove the minimum-email guard** in `handleRemoveEmail`:

Remove:
```
if (emails.length <= 1) {
  setEmailError("A lot owner must have at least one email address.");
  return;
}
```

The edit modal's "Remove" button on the last email should now be allowed to proceed. After removal the owner will have zero emails and be non-voteable — which is now valid.

---

## Downstream Impact

### Voting — OTP flow

`POST /api/auth/request-otp` looks up `LotOwnerEmail` records by email. An owner with no email rows will simply never match any lookup. They cannot request an OTP and cannot vote.

`POST /api/auth/verify` calls `_resolve_voter_state` which again queries `LotOwnerEmail`. No match → the email is not found → voter gets 401 (email not found for this building). This is correct and unchanged.

**No auth code changes needed.** The existing `.isnot(None)` filter in `_resolve_voter_state` (line 82 of `auth.py`) already guards against any hypothetical null email rows.

### Meeting close — absent records

`close_general_meeting` creates `BallotSubmission(is_absent=True)` for every lot in `GeneralMeetingLotWeight` that did not vote. For lots with no email, `emails_by_owner.get(lid, [])` returns `[]`, so `voter_email_str` becomes `""` (empty string). The absent record is created with a blank `voter_email`. **This is already handled correctly** — no code change needed.

### Results export / reporting

`get_general_meeting_detail` returns `voter_email` from the `BallotSubmission` row for absent lots. An email-less absent lot will show `""` in the absent voter list. The `VoterEntry` schema has `voter_email: str` which accepts empty string. **No schema change needed.**

The admin results page renders voter emails as plain text — blank emails will render as blank cells. **Acceptable.**

### Archive building logic

`archive_building` iterates over lot owners and checks whether any of their emails appear in another active building. For an email-less owner, `owner_emails` is `[]`, so `found_in_other` remains `False` and the owner is archived when their building is archived. This is the correct behaviour — email-less owners have no cross-building link. **No change needed.**

### `list_lot_owners` / `get_lot_owner` API responses

These return `emails: list[str]` which defaults to `[]` when there are no email rows. **Already correct.**

---

## Security Considerations

- The OTP enumeration-protection logic is unaffected: `request-otp` always returns 200 regardless of whether the email is known. Email-less owners simply never match.
- No new data exposure: email-less owners appear in admin lists with an empty email field — this is intentional and visible only to admins.
- Removing the "at least one email" guard from the edit modal does not introduce any injection risk — the remove-email API endpoint already handles zero-email owners gracefully (it just deletes the row and returns the updated owner with `emails: []`).

---

## Data Flow — Happy Path (Add Owner with No Email)

1. Admin navigates to Building Detail page and clicks "Add Lot Owner".
2. `AddForm` modal opens. Admin fills lot number and unit entitlement, leaves email blank.
3. On submit, frontend skips email validation (blank is allowed), calls `POST /api/admin/buildings/{id}/lot-owners` with `{ lot_number, unit_entitlement, financial_position, emails: [] }`.
4. `add_lot_owner` service creates `LotOwner` row, skips the email insertion loop (empty list), commits.
5. API returns `{ id, lot_number, emails: [], unit_entitlement, financial_position, proxy_email: null }`.
6. Building detail table refreshes, showing the new lot owner with a blank emails column.
7. At meeting close, owner appears in the absent tally with a blank voter_email in the absent `BallotSubmission` record.

---

## Schema Migration Note

**No Alembic migration is required.** The `lot_owner_emails` table already allows zero rows per `lot_owner`. No column or constraint changes are needed on any table.

---

## Vertical Slice Decomposition

This feature is small and touches both frontend and backend, but since no backend code changes are required, the entire feature is a single frontend-only slice. Backend unit/integration test updates are needed only to cover the "email-less owner" path through already-existing service code.

| Slice | Files changed | Independently testable |
|---|---|---|
| Frontend: relax AddForm + EditModal email guards | `frontend/src/components/admin/LotOwnerForm.tsx` | Yes — unit + integration tests against MSW |
| Backend: test coverage for email-less owners | `backend/tests/` | Yes — no prod code changes, only new test cases |

The two slices can run in parallel on the same branch since there is no shared state to coordinate.

---

## E2E Test Scenarios

The affected persona journey is **Admin** (building/meeting management). The existing E2E spec `frontend/e2e/admin/admin-lot-owners.spec.ts` must be updated — not only extended — to cover the email-optional behaviour.

### Happy Path

**Scenario 1: Add lot owner with no email via form**
1. Admin navigates to a building detail page.
2. Clicks "Add Lot Owner", fills lot number and unit entitlement, leaves email blank.
3. Submits form.
4. Owner appears in lot owner table with empty email.
5. Verify in browser: email column shows blank (not an error).

**Scenario 2: Add lot owner with email via form (regression)**
1. Admin navigates to a building detail page.
2. Clicks "Add Lot Owner", fills all fields including a valid email.
3. Submits form.
4. Owner appears in lot owner table with the email shown.
5. Confirms existing add-with-email flow is unchanged.

**Scenario 3: CSV import with blank email column**
1. Import CSV with `lot_number,email,unit_entitlement` where one row has blank email.
2. Verify import succeeds and returns `imported: 2, emails: 1` (or however many non-blank emails).
3. Lot owner with blank email appears in table.

**Scenario 4: CSV import without email column**
1. Import CSV with only `lot_number,unit_entitlement` columns (no email column at all).
2. Verify import succeeds.
3. All imported owners have empty email list.

**Scenario 5: Remove last email from existing owner via EditModal**
1. Admin opens edit modal for an owner with exactly one email.
2. Clicks "Remove" on that email.
3. Modal now shows an empty email list with the "Add email" input still visible.
4. Saves — owner now has zero emails.
5. Verify lot owner table shows blank email for that owner.

### Error/Edge Cases

**Scenario 6: Add lot owner with invalid email format**
1. Admin enters an email with invalid format (e.g. `notanemail`).
2. Submits form.
3. Form shows inline validation error "Please enter a valid email address."
4. API is not called.

**Scenario 7: Email-less owner is absent at meeting close**
1. Seed a building with one lot owner that has no email.
2. Create and open a meeting for that building.
3. Close the meeting.
4. Verify the absent tally includes the email-less lot owner.
5. Verify the absent `BallotSubmission` has `voter_email = ""`.

### State-Based Scenarios

**Scenario 8: Email-less owner cannot authenticate**
1. Seed an email-less lot owner.
2. Attempt to request an OTP using any email against the building's meeting.
3. OTP request returns 200 (enumeration-safe).
4. OTP verify returns 401 "Email address not found for this building" (or the standard OTP error).
5. Email-less owner cannot vote.

---

## Affected Persona Journeys

| Journey | Impact |
|---|---|
| **Admin** | Building management flow now allows adding lot owners without email. The existing `admin-lot-owners.spec.ts` must be updated with email-optional scenarios (Scenarios 1–5 above). |
| **Voter** | Unaffected — voters can only authenticate via email, and email-less owners simply never match the OTP lookup. No voter-side test changes needed. |
| **Meeting close** | Absent-record creation is unaffected; email-less owners produce absent records with blank `voter_email`. |
