# Design: Authentication — OTP Flow, Session Management, Admin Login Security

## Overview

Voter authentication uses a two-step email OTP flow. The voter enters their email address, receives an 8-character alphanumeric code, then submits the code to verify identity. On success the backend creates a stateful server-side session, sets an `HttpOnly` session cookie, and returns the session token in the response body for `localStorage` persistence so return visits can skip the OTP step. Admin login uses bcrypt + constant-time comparison to prevent timing oracles.

---

## Root Cause / Background

Replacing the original lot-number + email form with OTP prevents unauthorised access by anyone who merely knows a lot number. Persistent voter sessions (localStorage) eliminate repeated OTP friction when a voter closes and reopens a tab during the same meeting day.

---

## Technical Design

### Database changes

**`auth_otps` table** — stores issued OTP codes:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | auto-generated |
| `email` | VARCHAR | stored as supplied; case-sensitive, matching `LotOwnerEmail.email` semantics |
| `meeting_id` | UUID FK → `general_meetings.id` ON DELETE CASCADE | scope to one meeting |
| `code` | VARCHAR(20) | plain alphanumeric string (see security note) |
| `expires_at` | TIMESTAMPTZ | `now() + 5 minutes` at creation |
| `used` | BOOLEAN | set `TRUE` after successful verify; prevents replay |
| `created_at` | TIMESTAMPTZ | audit / cleanup |

Indexes: `ix_auth_otps_email_meeting` on `(email, meeting_id)`; `ix_auth_otps_expires_at` on `(expires_at)`.

**`session_records` table** — already existed:

| Column | Notes |
|---|---|
| `session_token` | VARCHAR UNIQUE |
| `voter_email` | VARCHAR |
| `building_id` | UUID FK |
| `general_meeting_id` | UUID FK |
| `expires_at` | TIMESTAMPTZ (24-hour TTL) |

No schema change required for session persistence.

### Backend changes

#### `POST /api/auth/request-otp`

File: `backend/app/routers/auth.py`

1. Fetch `GeneralMeeting` by `general_meeting_id`; return 404 if not found.
2. Look up `LotOwnerEmail` + `LotProxy` records for `(email, building_id)`. If no match is found still return `{"sent": true}` — enumeration protection.
3. Delete any prior OTPs for `(email, meeting_id)` (lazy cleanup).
4. Generate 8-char uppercase alphanumeric code from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (omits `O`, `0`, `I`, `1`).
5. Insert `AuthOtp(expires_at = now() + 5 min)`.
6. Send OTP email via `otp_email.html` Jinja2 template.
7. Return `{"sent": true}`.

Rate limit: rejects with 429 if the same `(email, meeting_id)` was sent within the last 60 seconds.

#### `POST /api/auth/verify`

1. Validate OTP: look up most-recent unused, unexpired `AuthOtp` for `(email, meeting_id)`.
2. Compare using `hmac.compare_digest(otp.code, request.code)` — constant-time comparison preventing timing oracle (US-IAS-01).
3. Mark `otp.used = TRUE`.
4. Look up all lot owner IDs: union of `LotOwnerEmail` (direct) + `LotProxy` (proxy) queries run in parallel via `asyncio.gather` with separate sessions.
5. Return 401 if no lots found.
6. For each lot: check `already_submitted` via `BallotSubmission(general_meeting_id, lot_owner_id)`.
7. Compute `unvoted_visible_count`: count of visible motions for which at least one of the voter's lots has no submitted vote.
8. Create `SessionRecord`; set `meeting_session` cookie (`HttpOnly`, `Secure` when `testing_mode=False`, `SameSite=Strict`).
9. Return `AuthVerifyResponse` including `session_token` in the body (needed for `localStorage` persistence since `HttpOnly` cookies are not JS-readable).

#### `POST /api/auth/session` (return-visit session restore)

Accepts `{ session_token, general_meeting_id }`. Validates the session record (expiry + AGM status). Runs the same lot-lookup and `unvoted_visible_count` computation as `POST /api/auth/verify`. Returns 401 if session expired or meeting closed.

#### Admin login security (`backend/app/routers/admin_auth.py`)

Both username and password checks always execute before combining results — bcrypt is never short-circuited by a username mismatch (US-IAS-02):

```python
valid_username = hmac.compare_digest(data.username, settings.admin_username)
valid_password = _verify_admin_password(data.password, settings.admin_password)
valid = valid_username and valid_password
```

#### Draft endpoint ownership check (`backend/app/routers/voting.py`)

`PUT /api/general-meeting/{id}/draft` and `GET /api/general-meeting/{id}/drafts` call `_verify_lot_ownership(db, voter_email, lot_owner_id, building_id)` when `lot_owner_id` is provided. Returns 403 if the voter neither owns nor has a proxy nomination for the lot in the meeting's building (US-IAS-03).

### Frontend changes

**`AuthForm.tsx`** (`frontend/src/components/vote/AuthForm.tsx`) — two-step UI:

- Step 1 ("email"): email input + "Send Verification Code" button
- Step 2 ("code"): OTP input with `autoComplete="one-time-code"` + "Verify" button + "Resend code" link
- Error regions use `role="alert"` for screen-reader announcements

**`AuthPage.tsx`** (`frontend/src/pages/vote/AuthPage.tsx`):

- Two mutations: `requestOtpMutation` and `verifyMutation`
- On `verifyMutation.onSuccess`: write `localStorage["agm_session_<meetingId>"]` = `data.session_token`; write sessionStorage keys; navigate based on `agm_status` / `unvoted_visible_count`
- On mount: read localStorage token; if found call `POST /api/auth/session`; show "Resuming your session…" while in flight; on 401 clear stale token and show OTP form normally
- `unvoted_visible_count > 0` → navigate to voting page; otherwise → confirmation page

**`frontend/src/api/voter.ts`**: `requestOtp()`, `verifyAuth()` (with `code` field), `restoreSession()`

**E2E helpers** (`frontend/e2e/workflows/helpers.ts`): `authenticateVoter(page, email, getOtp)` — fills email, clicks Send, calls injected `getOtp()` callback to retrieve code out-of-band from `GET /api/test/latest-otp` (test-only endpoint gated by `settings.testing_mode`), fills code, clicks Verify.

---

## Security Considerations

| Concern | Mitigation |
|---|---|
| User enumeration via `request-otp` | Always returns 200 regardless of email lookup result |
| OTP brute-force | 5-min expiry + single-use + 60s resend rate limit |
| Replay attack | `used = TRUE` after first successful verify |
| OTP timing oracle | `hmac.compare_digest` used for comparison (US-IAS-01) |
| Admin username timing oracle | Username + password both evaluated independently (US-IAS-02) |
| Draft cross-voter tampering | `_verify_lot_ownership` check on draft endpoints (US-IAS-03) |
| Secure cookie on localhost | `secure = not settings.testing_mode` (RR2-04) |
| Test endpoint in production | `GET /api/test/latest-otp` gated on `settings.testing_mode` |

---

## Files Changed

| File | Change |
|------|--------|
| `backend/app/models/auth_otp.py` | `AuthOtp` model |
| `backend/app/models/session_record.py` | Pre-existing `SessionRecord` model |
| `backend/app/routers/auth.py` | `request-otp`, `verify`, `session` endpoints; constant-time OTP comparison |
| `backend/app/routers/admin_auth.py` | Always-run bcrypt + `hmac.compare_digest` for username |
| `backend/app/routers/voting.py` | `_verify_lot_ownership` helper on draft endpoints |
| `backend/app/schemas/auth.py` | `OtpRequestBody`, `OtpRequestResponse`, `AuthVerifyRequest` (add `code`), `SessionRestoreRequest`, `AuthVerifyResponse` (add `session_token`, `unvoted_visible_count`) |
| `backend/app/templates/otp_email.html` | OTP email Jinja2 template |
| `backend/app/config.py` | `testing_mode: bool`, `email_override: str` |
| `backend/alembic/versions/` | Migration: `add_auth_otps_table` |
| `frontend/src/components/vote/AuthForm.tsx` | Two-step OTP form UI |
| `frontend/src/pages/vote/AuthPage.tsx` | Two mutations, localStorage persistence, return-visit detection |
| `frontend/src/api/voter.ts` | `requestOtp`, `restoreSession`, updated `AuthVerifyRequest` / `AuthVerifyResponse` |
| `frontend/e2e/workflows/helpers.ts` | Updated `authenticateVoter` signature |

---

## Schema Migration Required

Yes — `add_auth_otps_table` migration (adds `auth_otps` table).
