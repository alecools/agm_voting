# Design: Backend Review Fixes

PRD reference: `tasks/prd/prd-review-recommendations.md`

**Status:** Implemented

---

## Overview

This document covers the technical design for thirteen backend findings surfaced by the engineering review. The fixes span security, reliability, code quality, and compliance categories. No frontend changes are required.

---

## Findings summary

| ID | Category | Schema change? |
|---|---|---|
| SEC-1 | Replace fire-and-forget `asyncio.create_task` in auth.py with `BackgroundTasks` | No |
| SEC-2 | Remove `skip_email` from public `OtpRequestBody` schema | No |
| PERF-1 | Add compound index on `votes(general_meeting_id, lot_owner_id)` | Yes (new index) |
| SEC-4 | Key admin rate limiters on `current_user.user_id` not literal `"admin"` | No |
| BACKEND-2 | Cap `get_db` retry at 3 attempts (max ~3s wait) | No |
| SRE-2 | Launch `requeue_pending_on_startup` tasks as background (non-blocking) | No |
| BACKEND-3 | Move business logic from `auth.py` router into `auth_service.py` | No |
| BACKEND-4 | Assess parallelism of direct/proxy lot owner ID loaders | No change needed |
| SECURITY-MED-1 | Extend session duration to 2 hours; call `extend_session` from submit/save-draft | No |
| LEGAL-1 | Add `submitted_by_admin_user_id` column to `ballot_submissions` | Yes (new column) |
| BACKEND-5 | Add `max_length` validators to uncovered text fields in Pydantic schemas | No |
| BACKEND-6 | Make Jinja2 Environment a module-level singleton | No |
| CODE-3 | Add ballot hash verification endpoint | No |

---

## Technical Design

### SEC-1: Replace fire-and-forget `asyncio.create_task` with `BackgroundTasks`

**Problem:** `asyncio.create_task(...)` at lines ~229 and ~591 of `auth.py` creates unrooted tasks. On Lambda shutdown the event loop is torn down before these tasks complete, so cleanup silently never runs. Python 3.10+ also emits a "Task was destroyed but it is pending" warning.

**Fix:** FastAPI's `BackgroundTasks` is already injected in many admin endpoints. Add `background_tasks: BackgroundTasks` as a parameter to `request_otp` and `restore_session`, then call `background_tasks.add_task(...)` instead of `asyncio.create_task(...)`.

`_cleanup_expired_otps` and `_cleanup_expired_sessions` both open their own `AsyncSessionLocal` sessions internally and require no signature changes.

```
# Before (auth.py ~line 229)
asyncio.create_task(_cleanup_expired_otps())

# After
background_tasks.add_task(_cleanup_expired_otps)
```

**Files changed:**
- `backend/app/routers/auth.py` — add `BackgroundTasks` parameter to `request_otp` and `restore_session`; replace both `asyncio.create_task` calls

---

### SEC-2: Remove `skip_email` from public `OtpRequestBody`

**Problem:** `skip_email: bool = False` is in the public Pydantic schema, visible to any API caller. Even though the router gate `skip_email_effective = body.skip_email and settings.testing_mode` prevents delivery in production, the presence of the field widens the attack surface and violates least-surprise.

**Fix:**
- Delete `skip_email: bool = False` from `OtpRequestBody` in `backend/app/schemas/auth.py`
- In `auth.py` router, replace `skip_email_effective = body.skip_email and settings.testing_mode` with `skip_email_effective = settings.testing_mode`

When `TESTING_MODE=true`, all OTP emails are skipped. E2E tests retrieve codes via `GET /api/test/latest-otp` — no E2E changes needed.

**Files changed:**
- `backend/app/schemas/auth.py` — remove `skip_email` from `OtpRequestBody`
- `backend/app/routers/auth.py` — update `skip_email_effective` derivation

---

### PERF-1: Compound index on `votes(general_meeting_id, lot_owner_id)`

**Analysis:** The existing `perf001` migration added `ix_votes_lot_owner_id` on `(lot_owner_id)` only. The hot query in `submit_ballot` is:

```sql
WHERE general_meeting_id = X AND lot_owner_id IN (...) AND status = 'submitted'
```

A compound index `(general_meeting_id, lot_owner_id)` is more selective and allows PostgreSQL to push both predicates into a single index scan. The same compound filter also appears in `_resolve_voter_state`. At scale (large building, many AGMs), the single-column index causes unnecessary row-level filtering.

**Fix:** New Alembic migration `rr7001_add_votes_compound_gm_lot_owner_index` that creates `ix_votes_gm_lot_owner` on `(general_meeting_id, lot_owner_id)`.

The existing `ix_votes_lot_owner_id` is retained for lot_owner_id-only queries (cascade-delete lookups).

**Schema migration required:** Yes — new index only. Backward-compatible; can be applied to a live DB.

**Files changed:**
- `backend/alembic/versions/rr7001_add_votes_compound_gm_lot_owner_index.py` — new migration

---

### SEC-4: Admin rate limiters keyed on `current_user.user_id`

**Problem:** `admin_import_limiter.check("admin")` at four call sites and `admin_close_limiter.check("admin")` at one call site use a shared literal string. All authenticated admins deplete the same bucket within a Lambda instance.

**In-memory limitation acknowledged:** These limiters are intentionally in-memory per Lambda instance (documented in `rate_limiter.py` lines 14-21). This is the accepted design. The fix only changes the key from `"admin"` to `current_user.user_id`, reducing cross-user contention without requiring DB-backed limiting.

**Affected call sites:**
1. `import_buildings` (line ~329)
2. `import_lot_owners` (line ~553)
3. `import_proxy_nominations` (line ~579)
4. `import_financial_positions` (line ~605)
5. `close_general_meeting` (line ~1063)

Each needs `current_user: BetterAuthUser = Depends(require_admin)` injected if not already present.

**Files changed:**
- `backend/app/routers/admin.py` — update five `.check("admin")` calls; add `current_user` parameters where missing

---

### BACKEND-2: Cap `get_db` retry at 3 attempts

**Problem:** `_DB_RETRY_ATTEMPTS = 5`, `_DB_RETRY_BASE_WAIT = 2`. Worst-case wait = 2+4+8+16 = 30s sleep + 5×5s connection timeouts = 55s. This blocks all concurrent requests on the same Lambda instance during Neon cold start.

The CLAUDE.md architecture note already says "retries up to 3×" — the code at 5 retries is inconsistent with the documented intent.

**Fix:**
```python
_DB_RETRY_ATTEMPTS = 3
_DB_RETRY_BASE_WAIT = 1   # waits: 1s, 2s; max total = 3s sleep + 3x5s timeouts = 18s
```

**Files changed:**
- `backend/app/database.py` — update constants and docstring

---

### SRE-2: Non-blocking `requeue_pending_on_startup`

**Problem:** `requeue_pending_on_startup` calls `await asyncio.gather(*tasks)` during the FastAPI lifespan startup event. This blocks the Lambda from serving HTTP requests until all retry tasks complete — potentially minutes if many deliveries are pending.

**Fix:** Replace `await asyncio.gather(*tasks, return_exceptions=True)` with a loop of `asyncio.create_task(...)` calls. At startup time (not request time), `create_task` is appropriate because the event loop is already running and the tasks are long-lived retry loops that should not block startup.

```python
# Before
results = await asyncio.gather(*tasks, return_exceptions=True)
for exc in results:
    if isinstance(exc, BaseException):
        logger.error(...)

# After
for task_coro in tasks:
    asyncio.create_task(task_coro)
```

Remove the exception-logging loop — `trigger_with_retry` already logs its own errors internally.

**Files changed:**
- `backend/app/services/email_service.py` — replace `asyncio.gather` with `create_task` loop in `requeue_pending_on_startup`

---

### BACKEND-3: Move business logic from `auth.py` into `auth_service.py`

**Problem:** `auth.py` is ~700 lines with non-router logic inline.

**Functions to move to `auth_service.py`:**
- `_resolve_voter_state(db, voter_email, general_meeting_id, building_id) -> dict`
- `_upsert_rate_limit(db, email, building_id, now) -> None`
- `_cleanup_expired_otps() -> None`
- `_cleanup_expired_sessions() -> None`
- Extract phone-hint masking as `mask_phone_hint(phone_number: str) -> str` (pure function)

The `OTPRateLimit` model import moves from `auth.py` to `auth_service.py`. The `auth.py` router imports these from `auth_service.py`.

`_cleanup_expired_otps` and `_cleanup_expired_sessions` retain their own internal `AsyncSessionLocal` sessions.

**Files changed:**
- `backend/app/services/auth_service.py` — add five functions
- `backend/app/routers/auth.py` — remove the functions; import from `auth_service`

---

### BACKEND-4: Assessment of parallel DB connections in lot owner ID loaders

**Current design:** `_load_direct_lot_owner_ids` and `_load_proxy_lot_owner_ids` open separate sessions for concurrent execution via `asyncio.gather`. Each auth request uses 3 concurrent connections.

**Assessment:** With `pool_size=20, max_overflow=10`, 3-connection bursts per auth request are well within pool capacity. The concurrent queries reduce auth latency by overlapping two serial round-trips. This is worthwhile.

**Decision:** No change. Document the trade-off to avoid future second-guessing.

---

### SECURITY-MED-1: Extend session duration to 2 hours

**Fix:**
1. `SESSION_DURATION = timedelta(hours=2)` in `auth_service.py` (currently `timedelta(minutes=30)`)
2. `_TOKEN_MAX_AGE_SECONDS` is derived automatically from `SESSION_DURATION.total_seconds()` — becomes 7200
3. Call `extend_session` from the voting router after successful `save_draft` and `submit_ballot` so the clock resets on each interaction

`extend_session` already exists in `auth_service.py`. The voting router needs to:
- Accept the session cookie
- After service call succeeds, call `extend_session(db, session_record)`
- Re-set the `agm_session` cookie with the new signed token and updated `max_age`

**Files changed:**
- `backend/app/services/auth_service.py` — `SESSION_DURATION = timedelta(hours=2)`
- `backend/app/routers/voting.py` — call `extend_session` and re-set cookie in `save_draft` and `submit_ballot` handlers

---

### LEGAL-1: Add `submitted_by_admin_user_id` column

**Problem:** `submitted_by_admin_username` is a mutable string. Admin rename/deletion breaks the audit link.

**New column:**
```sql
ALTER TABLE ballot_submissions
  ADD COLUMN submitted_by_admin_user_id VARCHAR(255) NULL;
```

**SQLAlchemy model:**
```python
submitted_by_admin_user_id: Mapped[str | None] = mapped_column(
    String(255), nullable=True, default=None
)
```

**Service change:** `enter_votes_for_meeting` signature gains `admin_user_id: str | None = None`. The `BallotSubmission` creation sets both `submitted_by_admin_username` (retained for backward compat) and `submitted_by_admin_user_id`.

**Router change:** Pass `admin_user.id` as `admin_user_id` in `admin.py`.

Migration naming: `rr7002_add_submitted_by_admin_user_id`

**Schema migration required:** Yes — nullable column addition (backward-compatible).

**Files changed:**
- `backend/alembic/versions/rr7002_add_submitted_by_admin_user_id.py`
- `backend/app/models/ballot_submission.py`
- `backend/app/services/admin_service.py`
- `backend/app/routers/admin.py`

---

### BACKEND-5: Add `max_length` to uncovered text fields

**Gaps found in `schemas/auth.py`:**
- `OtpRequestBody.email` — no `max_length`; add 254 (RFC 5321)
- `AuthVerifyRequest.email` — no `max_length`; add 254
- `AuthVerifyRequest.code` — no `max_length`; add 20 (OTP is 8 chars; cap at 20 to be generous)

All other key fields in `schemas/admin.py` already have `max_length` per the existing implementation.

**Files changed:**
- `backend/app/schemas/auth.py` — add `Field(max_length=254)` / `Field(max_length=20)` to listed fields

---

### BACKEND-6: Jinja2 Environment singleton

**Problem:** `_get_jinja_env()` creates a new `Environment(loader=FileSystemLoader(...))` on every call, performing filesystem stats on each email send.

**Fix:** Replace with a module-level constant:

```python
_jinja_env: Environment = Environment(
    loader=FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=select_autoescape(["html"]),
)
```

Replace all `env = _get_jinja_env()` usages with `_jinja_env`. Remove `_get_jinja_env()`.

**Files changed:**
- `backend/app/services/email_service.py`

---

### CODE-3: Ballot hash verification endpoint

**New endpoint:**

```
GET /api/admin/general-meetings/{general_meeting_id}/verify-ballot/{ballot_id}
```

- Auth: admin only
- Returns `BallotVerifyOut`:

```json
{
  "verified": true,
  "ballot_id": "...",
  "computed_hash": "abc123...",
  "stored_hash": "abc123..."
}
```

**Logic:**
1. Fetch `BallotSubmission` by `ballot_id` where `general_meeting_id` matches; 404 if not found
2. Fetch all submitted `Vote` rows for `(general_meeting_id, submission.lot_owner_id)` with `status = submitted`
3. Build `vote_choices = [(str(v.motion_id), v.choice.value if v.choice else "none") for v in votes]`
4. Call `compute_ballot_hash(general_meeting_id, submission.lot_owner_id, vote_choices)`
5. Return `verified = (computed == stored)`, plus both hash values

**Rename:** `_compute_ballot_hash` in `voting_service.py` becomes `compute_ballot_hash` (exported, no leading underscore).

**New schema:**
```python
class BallotVerifyOut(BaseModel):
    verified: bool
    ballot_id: uuid.UUID
    computed_hash: str
    stored_hash: str | None
```

**Files changed:**
- `backend/app/routers/admin.py` — new endpoint
- `backend/app/schemas/admin.py` — `BallotVerifyOut`
- `backend/app/services/voting_service.py` — rename `_compute_ballot_hash` → `compute_ballot_hash`

---

## Security Considerations

- **SEC-1:** Reliability improvement; no security impact.
- **SEC-2:** Removes latent attack-surface field from public schema.
- **SEC-4:** Prevents cross-user rate-limit contention within a Lambda instance.
- **SECURITY-MED-1:** Session extension on every submit is safe — sessions are server-side, revocable, and `HttpOnly`-cookie bound.
- **CODE-3:** Admin-only read endpoint; no PII exposure beyond what admins can already access in the meeting detail view.
- All other changes are internal refactors or additive schema changes with no new security implications.

---

## Files to Change

| File | Change |
|---|---|
| `backend/app/routers/auth.py` | SEC-1, SEC-2 (schema ref), BACKEND-3 |
| `backend/app/schemas/auth.py` | SEC-2, BACKEND-5 |
| `backend/app/services/auth_service.py` | BACKEND-3, SECURITY-MED-1 |
| `backend/app/routers/voting.py` | SECURITY-MED-1 |
| `backend/app/routers/admin.py` | SEC-4, LEGAL-1, CODE-3 |
| `backend/app/schemas/admin.py` | CODE-3 |
| `backend/app/database.py` | BACKEND-2 |
| `backend/app/services/email_service.py` | SRE-2, BACKEND-6 |
| `backend/app/models/ballot_submission.py` | LEGAL-1 |
| `backend/app/services/admin_service.py` | LEGAL-1 |
| `backend/app/services/voting_service.py` | CODE-3 |
| `backend/alembic/versions/rr7001_add_votes_compound_gm_lot_owner_index.py` | PERF-1 (new file) |
| `backend/alembic/versions/rr7002_add_submitted_by_admin_user_id.py` | LEGAL-1 (new file) |

---

## Schema Migration Required

**Yes** — two migrations:

1. `rr7001_add_votes_compound_gm_lot_owner_index` — new index `ix_votes_gm_lot_owner` on `votes(general_meeting_id, lot_owner_id)`
2. `rr7002_add_submitted_by_admin_user_id` — new nullable column `submitted_by_admin_user_id VARCHAR(255)` on `ballot_submissions`

Both are backward-compatible. A failed migration leaves the DB in a valid state.

---

## Test Plan

### Unit tests (mocked DB)

| Change | Test cases |
|---|---|
| SEC-1 | `request_otp` and `restore_session` call `background_tasks.add_task`; no `asyncio.create_task` |
| SEC-2 | `OtpRequestBody` with `skip_email=true` in body — field must be rejected or ignored; `testing_mode=True` skips delivery without `skip_email` field |
| PERF-1 | Migration runs cleanly (upgrade + downgrade) against test DB |
| SEC-4 | Each user_id gets its own rate-limit bucket; bucket is not shared across user IDs |
| BACKEND-2 | `get_db` yields session on first success; raises last error after exactly 3 failed attempts |
| SRE-2 | `requeue_pending_on_startup` creates tasks with `asyncio.create_task` and returns immediately |
| BACKEND-3 | `_resolve_voter_state`, `_upsert_rate_limit`, etc. are importable from `auth_service`; router imports succeed |
| SECURITY-MED-1 | `SESSION_DURATION == timedelta(hours=2)`; voting router calls `extend_session` |
| LEGAL-1 | `BallotSubmission` rows created via `enter_votes_for_meeting` have both `submitted_by_admin_username` and `submitted_by_admin_user_id` set |
| BACKEND-5 | `OtpRequestBody(email="a"*255)` raises `ValidationError`; `AuthVerifyRequest(code="x"*21)` raises `ValidationError` |
| BACKEND-6 | `_jinja_env` is a module-level `Environment`; `id(_jinja_env)` is stable across two calls |
| CODE-3 | `compute_ballot_hash` returns matching hash; verify endpoint returns `verified=True` on match, `verified=False` on mismatch, 404 on missing ballot |

### Integration tests (real test DB)

| Change | Test cases |
|---|---|
| PERF-1 | Index `ix_votes_gm_lot_owner` exists in DB schema after migration |
| LEGAL-1 | End-to-end admin vote entry populates `submitted_by_admin_user_id` |
| SECURITY-MED-1 | Session cookie `max_age = 7200` after verify and after submit |
| CODE-3 | Submit ballot → call verify → `verified=True` |

---

## E2E Test Scenarios

### Happy path — ballot hash verification
1. Admin creates meeting, adds motions, starts meeting
2. Voter authenticates and submits ballot
3. Admin calls `GET /api/admin/general-meetings/{id}/verify-ballot/{ballot_id}`
4. Assert `verified: true` and `computed_hash == stored_hash`

### Error path — verify ballot not found
1. Admin calls verify endpoint with a random ballot UUID
2. Assert 404

### Multi-step sequence — session extension through voting flow
1. Voter authenticates; assert session cookie `max_age` ≈ 7200
2. Voter saves a draft; assert session cookie `max_age` reset to ≈ 7200
3. Voter submits ballot; assert session cookie `max_age` reset to ≈ 7200

### Existing E2E specs affected
- All OTP-request workflows: the `skip_email` field is removed from `OtpRequestBody`. Verify no E2E test passes `skip_email` in the request body (they use `GET /api/test/latest-otp` to retrieve codes, which is unaffected).
- Any spec asserting session timeout behaviour should be updated to reflect the new 2-hour duration (SECURITY-MED-1).
