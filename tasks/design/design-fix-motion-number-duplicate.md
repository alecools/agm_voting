# Design: Fix Duplicate motion_number Add Returning 500 Instead of 409

## Overview

When an admin adds a motion via `POST /api/admin/general-meetings/{id}/motions` and provides a `motion_number` that already exists on another motion in the same meeting, the database `uq_motions_general_meeting_motion_number` partial unique index fires an `IntegrityError`. FastAPI's default exception handling converts uncaught `IntegrityError` to an HTTP 500. The correct response is 409 Conflict.

This is a pure backend fix — no schema changes, no frontend changes.

---

## Root Cause

`add_motion_to_meeting` in `backend/app/services/admin_service.py` does not catch `IntegrityError` before calling `db.flush()` / `db.commit()`. When the partial unique index on `(general_meeting_id, motion_number) WHERE motion_number IS NOT NULL` is violated, the uncaught exception propagates through FastAPI's exception handlers, resulting in a 500 response with no meaningful error message.

---

## Database Changes

None. The partial unique index already exists (added in the `feat/custom-motion-number-and-reorder` migration).

---

## Backend Changes

### `backend/app/services/admin_service.py` — `add_motion_to_meeting`

Wrap the `db.flush()` call (after inserting the new `Motion` row) in a try/except that catches `sqlalchemy.exc.IntegrityError`. When caught:

1. Roll back the transaction to remove the failed insert.
2. Check whether the error message references the `uq_motions_general_meeting_motion_number` constraint.
3. If yes, raise `HTTPException(status_code=409, detail="A motion with this motion number already exists in this meeting.")`.
4. If the constraint name does not match, re-raise the original exception so other integrity errors (e.g. display_order conflict) still surface as 500.

---

## Frontend Changes

None. The frontend already handles 409 responses from the Add Motion endpoint — the error message is shown inline in the Add Motion form.

---

## Key Design Decision

Catching the exception at the service layer (rather than in the router) keeps the router thin and is consistent with how other constraint violations (e.g. duplicate building name) are handled across this codebase.

---

## Schema Migration Note

**Schema migration needed: NO.**

---

## E2E Test Scenarios

### Affected journey: Admin (meeting management — add motion)

The existing admin motion management E2E spec must be updated:

#### Error / edge cases
- **SC-DUP-01**: Admin adds a motion with `motion_number = "5"`. Then adds a second motion with `motion_number = "5"`. The add-motion form shows an inline error: "A motion with this motion number already exists in this meeting." No motion is created.
- **SC-DUP-02**: Admin adds two motions with no explicit motion number (auto-assigned). The second auto-assigned number does not collide with the first (sequential `display_order` guarantees distinct values). Both motions are created successfully.
