# Design: Critical Runtime Bug Fixes

**PRD:** `tasks/prd/prd-review-recommendations.md` (RR3-03, RR3-04)
**Schema changes:** None required.

---

## Overview

Four critical runtime bugs identified in the second 8-perspective team review. All are code-only fixes — no schema migrations needed.

| ID | Bug | File | Severity |
|----|-----|------|----------|
| C-2 | `await db.delete()` on synchronous method → `TypeError` at runtime | `admin_auth.py:76,120` | CRITICAL |
| C-7 | Ballot submission reads `lotOwnerIds` from sessionStorage before write completes → empty ballot | `VotingPage.tsx:249` | CRITICAL |
| C-8 | `Vote` rows flushed outside `SELECT FOR UPDATE` lock → orphaned votes on duplicate submission | `voting_service.py:446` | CRITICAL |
| C-9 | Email retry task has no distributed lock → duplicate sends on concurrent close or Lambda restart | `email_service.py:306` | CRITICAL |

---

## C-2: `await db.delete()` TypeError in admin_auth.py

### Root cause

`AsyncSession.delete()` is a **synchronous** method that schedules a model instance for deletion in the unit-of-work. It returns `None`, not a coroutine. Awaiting it raises `TypeError: object NoneType can't be used in 'await' expression` at runtime.

```python
# WRONG — lines 76 and 120:
await db.delete(attempt_record)

# CORRECT pattern (used elsewhere in the codebase):
await db.execute(delete(AdminLoginAttempt).where(AdminLoginAttempt.id == attempt_record.id))
```

### Fix

Replace both `await db.delete(attempt_record)` calls with `await db.execute(delete(...).where(...))` using the bulk-delete pattern.

**Files to change:**
- `backend/app/routers/admin_auth.py:76` — cleanup after successful login
- `backend/app/routers/admin_auth.py:120` — cleanup after rate-limit reset

### Tests required

- Unit test: admin login succeeds → rate limit record is deleted (currently raises `TypeError`, so this test was never passing)
- Unit test: rate limit reset path deletes the record

---

## C-7: Ballot submission sessionStorage race condition

### Root cause

`submitMutation`'s `mutationFn` reads `lotOwnerIds` from `sessionStorage` after the mutation is triggered:

```typescript
// VotingPage.tsx lines 249-262 (approximate)
mutationFn: () => {
  const storedLots = sessionStorage.getItem(`meeting_lots_${meetingId}`);
  const lotOwnerIds = storedLots ? JSON.parse(storedLots) : [];  // may be [] if read before write
  return submitBallot(meetingId!, { lot_owner_ids: lotOwnerIds, votes, multiChoiceVotes });
}
```

`sessionStorage.setItem()` is called in `handleSubmitClick()` immediately before `submitMutation.mutate()`. In practice the write always precedes the read because both are synchronous on the same thread, but the mutation function closing over sessionStorage rather than its trigger-time value is a latent bug that can fail if the mutation is retried or triggered through a different code path.

### Fix

Pass `lotOwnerIds` as a parameter to `mutate()` at call time, closing over the value at trigger time rather than re-reading from storage inside the mutationFn:

```typescript
// mutationFn receives its inputs directly
mutationFn: ({ lotsToSubmit, votes, multiChoiceVotes }: SubmitPayload) =>
  submitBallot(meetingId!, {
    lot_owner_ids: lotsToSubmit,
    votes,
    multi_choice_votes: multiChoiceVotes,
  }),

// Call site passes values explicitly
submitMutation.mutate({
  lotsToSubmit: isMultiLot ? [...selectedIds] : [currentLot.lot_owner_id],
  votes: currentVotes,
  multiChoiceVotes: currentMultiChoiceVotes,
});
```

sessionStorage writes for persistence can remain, but the mutation no longer depends on them for correctness.

**Files to change:**
- `frontend/src/pages/vote/VotingPage.tsx` — `submitMutation` definition and call site(s)

### Tests required

- Unit test: `submitMutation` called with correct `lot_owner_ids` matching the selected lots at call time
- Unit test: mutation retried after failure still uses the original call-time `lotOwnerIds`, not a re-read

---

## C-8: Orphaned Vote records from concurrent submission race

### Root cause

`submit_ballot()` acquires a `SELECT FOR UPDATE` lock on `BallotSubmission` to prevent duplicate submissions, but inserts `Vote` rows via `await db.flush()` **before** the `BallotSubmission` INSERT. If two concurrent requests both flush their votes before either commits the `BallotSubmission`, the request that loses the unique-constraint race rolls back its transaction — but its already-flushed `Vote` rows may be orphaned if the flush happened in a subtransaction or if the ORM doesn't roll them back cleanly.

```python
# voting_service.py (simplified)
async with db.begin_nested():             # savepoint / subtransaction
    await db.flush()                      # Vote rows inserted HERE (line ~446)
    # ... later ...
    ballot = BallotSubmission(...)
    db.add(ballot)
    await db.flush()                      # UNIQUE constraint may fail HERE for loser
```

The outer transaction should roll back all votes on constraint failure, but the lock is only on `BallotSubmission`, not on the vote-insert phase. Under certain ORM flush ordering, votes can survive a rolled-back `BallotSubmission` in edge cases.

### Fix

Move all vote inserts and the `BallotSubmission` insert into the **same locked scope**:

1. Acquire `SELECT FOR UPDATE` on the `(general_meeting_id, lot_owner_id)` check row **first**, before building any Vote objects.
2. Build all Vote objects in memory (no flush yet).
3. Add the `BallotSubmission` and all `Vote` objects to the session in a single batch.
4. Issue a single `await db.flush()` covering both the `BallotSubmission` and all its `Vote` rows atomically.
5. Catch `IntegrityError` on the flush and return 409 — at this point either all rows are committed or none are.

```python
# After lock acquisition:
votes_to_insert = build_votes(...)          # pure Python, no DB
ballot = BallotSubmission(...)
db.add(ballot)
for vote in votes_to_insert:
    db.add(vote)
await db.flush()                            # single atomic flush
```

**Files to change:**
- `backend/app/services/voting_service.py` — `submit_ballot()` — restructure vote building and flush order

### Tests required

- Integration test (extends US-TCG-02 / US-OPS-08): two concurrent submissions → exactly one succeeds → DB contains exactly N votes, all belonging to the successful submission → zero orphaned votes (verify with `SELECT * FROM votes WHERE lot_owner_id = X AND general_meeting_id = Y` count matches the successful submission's vote count)

---

## C-9: Email delivery race condition — duplicate sends

### Root cause

`trigger_with_retry(agm_id)` runs as an `asyncio.Task` with no distributed lock. Two paths can trigger duplicate sends:

**Path A — concurrent close requests:**
1. Admin double-clicks "Close meeting" → two `POST /api/admin/agms/{id}/close` requests in flight
2. Both succeed the status update (first wins, second either 409s or races to the same row)
3. Each creates an independent `asyncio.create_task(trigger_with_retry(agm_id))`
4. Both tasks independently send the email

**Path B — Lambda restart after send, before status commit:**
1. Task calls `send_report()` (email sent)
2. Lambda cold-starts before `EmailDelivery.status` is updated to `sent`
3. `requeue_pending_on_startup()` finds the record still `pending`
4. A new task is created and sends the email again

### Fix

Use a PostgreSQL advisory lock keyed on the `agm_id` to ensure only one task is executing the send/retry loop for a given meeting at any time:

```python
import hashlib

async def _try_acquire_email_lock(db: AsyncSession, agm_id: UUID) -> bool:
    """Returns True if lock acquired, False if another process holds it."""
    lock_id = int(hashlib.sha256(str(agm_id).encode()).hexdigest()[:8], 16) % 2147483647
    result = await db.execute(text(f"SELECT pg_try_advisory_xact_lock({lock_id})"))
    return result.scalar()

async def trigger_with_retry(agm_id: UUID, db: AsyncSession) -> None:
    if not await _try_acquire_email_lock(db, agm_id):
        logger.info("email_send_skipped_lock_held", agm_id=str(agm_id))
        return
    # ... existing retry loop ...
```

For Path B (restart after send): before sending, re-check `EmailDelivery.status` inside the lock. If `status == "sent"`, skip immediately:

```python
delivery = await db.get(EmailDelivery, delivery_id)
if delivery.status == EmailDeliveryStatus.sent:
    logger.info("email_already_sent_skip", agm_id=str(agm_id))
    return
```

**Files to change:**
- `backend/app/services/email_service.py` — `trigger_with_retry()` and `requeue_pending_on_startup()`

### Tests required

- Integration test: two concurrent `trigger_with_retry` calls for same `agm_id` → mock SMTP → assert `send_report()` called exactly once
- Integration test: simulate restart scenario — `EmailDelivery.status = sent`, call `trigger_with_retry` → assert `send_report()` not called
- Unit test: `_try_acquire_email_lock` returns `False` when lock is held

---

## Implementation order

Fix in this order to unblock tests at each step:

1. **C-2** — 15 min, self-contained, unblocks admin login rate-limit tests
2. **C-7** — 30 min, frontend-only, unblocks ballot submission tests
3. **C-8** — 1–2 hours, requires careful transaction restructuring; run concurrent integration test after
4. **C-9** — 2–3 hours, requires advisory lock plumbing and restart simulation test

All four fixes are independent of each other and can be done on the same branch.

## E2E test scenarios

No new E2E scenarios required — these are correctness fixes to existing flows. Existing E2E ballot submission and meeting close specs should continue to pass after the fixes. The new integration tests (C-8 concurrent, C-9 duplicate send) exercise the race conditions directly.
