# Design: Authentication Security Hardening

**Status:** Implemented

**PRD:** `tasks/prd/prd-review-recommendations.md` (US-IAS-01, US-IAS-02, US-IAS-03, RR2-04)

---

## Overview

Four security issues identified in the engineering review are addressed in this slice:

1. **US-IAS-01** — OTP verification uses `==` (susceptible to timing oracle)
2. **US-IAS-02** — Admin login short-circuits on wrong username before bcrypt runs
3. **US-IAS-03** — Draft save/get endpoints lack ownership verification
4. **RR2-04** — Cookie `Secure=True` breaks local `http://localhost` development

No schema changes are required. All fixes are code-only.

---

## Root Cause Analysis

### US-IAS-01: OTP timing oracle

**Root cause:** `otp.code != request.code` uses Python's default `str.__eq__`, which is _not_ guaranteed to be constant-time. In CPython the comparison returns early on the first mismatched byte, leaking partial information about the stored code via response-time differences. An adversary making thousands of requests could measure these differences and narrow down the correct code.

**Fix:** Replace the equality check with `hmac.compare_digest(otp.code, request.code)`, which is explicitly defined in PEP 452 to run in constant time regardless of how many bytes match. The `None` check is kept as a separate branch (no timing leak because we return 401 immediately without running a comparison).

### US-IAS-02: Admin login username timing oracle

**Root cause:** The login handler used short-circuit `and`:
```python
valid = (data.username == settings.admin_username
         and _verify_admin_password(data.password, settings.admin_password))
```
When `data.username != settings.admin_username`, Python's `and` skips the bcrypt call entirely. An adversary could measure whether the response was fast (username wrong, no bcrypt) or slow (username right, bcrypt ran) and enumerate valid usernames with ~30 ms timing difference per request.

**Fix:** Evaluate both comparisons independently so bcrypt _always_ runs:
```python
valid_username = hmac.compare_digest(data.username, settings.admin_username)
valid_password = _verify_admin_password(data.password, settings.admin_password)
valid = valid_username and valid_password
```
`hmac.compare_digest` is used for the username string comparison for the same reason as US-IAS-01.

### US-IAS-03: Draft endpoint missing ownership check

**Root cause:** `PUT /api/general-meeting/{id}/draft` and `GET /api/general-meeting/{id}/drafts?lot_owner_id=...` accepted arbitrary `lot_owner_id` values from the request without verifying that the authenticated voter actually owns (or is proxy for) that lot. A voter with a valid session could supply any `lot_owner_id` and read or overwrite another voter's draft choices.

**Fix:** A new helper `_verify_lot_ownership(db, voter_email, lot_owner_id, building_id)` is added to `voting.py`. It checks:
1. `LotOwnerEmail` — the email is a direct owner of the lot within the building, or
2. `LotProxy` — the email is a nominated proxy for the lot within the building.

If neither condition holds, it raises HTTP 403. Both draft endpoints call this helper before delegating to the service layer.

**Intentional bypass when `lot_owner_id` is `None`:** When `lot_owner_id` is omitted from the request body, the ownership check is skipped. This is safe for two reasons:
1. The DELETE path (`choice=None`) only issues a `DELETE WHERE voter_email = ?` — no new row is created, so no cross-voter tampering is possible.
2. The UPDATE path finds an existing draft by `voter_email`; if no draft exists, a new `Vote` is inserted — but the DB schema has a NOT NULL constraint on `votes.lot_owner_id`, which blocks any insert with `lot_owner_id=None` at the DB level.

The `None` case is preserved for backward compatibility with older frontend clients that do not yet send `lot_owner_id`. A cross-building isolation check is enforced: the `building_id` is always taken from the meeting (not from the request), so a `lot_owner_id` belonging to a lot in a different building returns 403 even if the voter's email is associated with that lot.

### RR2-04: Secure cookie flag breaks localhost

**Root cause:** `Set-Cookie: agm_session=...; Secure` instructs the browser to only send the cookie over HTTPS. Local development servers run on `http://localhost`, so the browser silently drops the cookie after it is set, preventing session persistence in local dev.

**Fix:** Change `secure=True` to `secure=not settings.testing_mode`. The `testing_mode` flag already exists in `app/config.py` and is set to `True` in test and local development environments. In all deployed environments (Vercel preview and production) `testing_mode=False`, so `Secure` remains `True`. The `HttpOnly` and `SameSite=Strict` attributes are unconditional and unaffected.

---

## Files Changed

| File | Change |
|------|--------|
| `backend/app/routers/auth.py` | Add `import hmac`; split OTP comparison into `None` guard + `hmac.compare_digest`; change both `set_cookie(secure=True)` calls to `secure=not settings.testing_mode` |
| `backend/app/routers/admin_auth.py` | Add `import hmac`; evaluate username and password independently using `hmac.compare_digest` + bcrypt |
| `backend/app/routers/voting.py` | Add `_verify_lot_ownership()` helper; call it in `save_draft_endpoint` and `get_drafts_endpoint` (when `lot_owner_id` query param is present) |

---

## Schema Changes

None. No Alembic migration is required.

---

## Test Plan

New tests are added to existing test files rather than new files, to keep coverage cohesive.

| Test | File | What is verified |
|------|------|-----------------|
| OTP correct code passes comparison | `test_phase2_api.py` or `test_security_hardening.py` | `hmac.compare_digest` path executes on correct code |
| OTP wrong code returns 401 | new section in `test_phase2_api.py` | Wrong code rejected even when OTP row exists |
| Admin login wrong username still runs bcrypt | `test_admin_auth_api.py` | Wrong username → 401, same as wrong password |
| Admin login timing-safe: both branches evaluated | `test_admin_auth_api.py` | `hmac.compare_digest` imported and used |
| Draft save with own lot succeeds | `test_phase2_api.py` | 200 for owner's own lot |
| Draft save with another voter's lot returns 403 | `test_phase2_api.py` | 403 when `lot_owner_id` belongs to a different voter |
| Draft get with own lot_owner_id succeeds | `test_phase2_api.py` | 200 |
| Draft get with another voter's lot_owner_id returns 403 | `test_phase2_api.py` | 403 |
| Cookie `Secure=False` when `testing_mode=True` | `test_phase2_api.py` | `set-cookie` header lacks `secure` attribute in test mode |
| Cookie `Secure=True` when `testing_mode=False` | `test_phase2_api.py` | `set-cookie` header contains `secure` in production mode |
| bcrypt called even when username is wrong | `test_phase2_api.py` | `_verify_admin_password` mock asserted called once for wrong-username request |
| Draft save `lot_owner_id=None` bypasses check intentionally | `test_phase2_api.py` | Endpoint returns 200 when `lot_owner_id` is omitted |
| Draft save lot from different building returns 403 | `test_phase2_api.py` | building_id boundary enforced — cross-building lot rejected |
| Draft get lot from different building returns 403 | `test_phase2_api.py` | GET /drafts?lot_owner_id= from different building returns 403 |

---

## E2E Test Scenarios

All four changes in this slice are **internal implementation changes only** — they do not alter the public API shape, request/response schemas, or any UI behaviour. As a result, no existing Playwright E2E specs require modification and no new E2E scenarios are needed.

### Why no E2E changes are required

| Change | Reason no E2E change needed |
|--------|-----------------------------|
| US-IAS-01 — OTP `hmac.compare_digest` | Replaces one comparison operator with another; external behaviour is identical. The voter auth E2E flow (`e2e/voter.spec.ts`) continues to pass an OTP and land on the voting page — the implementation detail of how the comparison is done is invisible to the browser. |
| US-IAS-02 — Admin login `hmac.compare_digest` + always-run bcrypt | Changes internal evaluation order; the admin login E2E flow (`e2e/admin.spec.ts`) is unaffected — correct credentials still succeed, wrong credentials still return 401. |
| US-IAS-03 — Draft ownership check | Only adds a new 403 error path that is triggered by a malicious caller supplying an arbitrary `lot_owner_id`. The legitimate voter flow always supplies the voter's own lot and therefore never encounters the 403. Existing voter and proxy E2E flows are unaffected. |
| RR2-04 — Conditional `Secure` cookie | In the deployed preview environment (`testing_mode=False`) the cookie retains `Secure=True`, so the E2E tests running against the preview deployment see no change. The fix only relaxes the flag in local `http://localhost` environments where `testing_mode=True`. |

### Existing E2E specs that exercise the affected code paths

The following specs run the code touched by this slice and must pass without modification after this change:

| Spec | Path | What it exercises |
|------|------|-------------------|
| Voter auth flow | `frontend/e2e/voter.spec.ts` | OTP request, OTP verify (US-IAS-01), session cookie set (RR2-04) |
| Admin login | `frontend/e2e/admin.spec.ts` | Admin credential check (US-IAS-02) |
| Draft auto-save | `frontend/e2e/voter.spec.ts` | Draft PUT with own lot_owner_id (US-IAS-03 happy path) |
