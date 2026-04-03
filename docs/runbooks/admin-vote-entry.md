# Runbook: Admin Vote Entry and Per-Motion Voting Windows

Use this runbook to:

1. Record in-person votes on behalf of lot owners who did not vote online
2. Open and close per-motion voting windows during a meeting
3. Recover from a failure that interrupts a mid-batch admin vote entry

Estimated time: **5–15 minutes depending on batch size**.

---

## Prerequisites

- Admin login credentials (from `ADMIN_USERNAME` / `ADMIN_PASSWORD` Vercel env vars)
- The meeting must exist and its status must be `open` for all vote-entry operations
- Lot owner IDs — visible in the lot owner list (`GET /api/admin/buildings/{id}/lot-owners`)

---

## 1. Admin Vote Entry — Entering In-Person Votes

Use this workflow when lot owners attended the meeting in person but did not submit their vote via the online portal.

### Step 1: Confirm the meeting is open

In the admin portal, navigate to **Meetings → [Meeting Name]** and confirm the status shows **Open**.

If the status is `closed`, no further vote entry is possible. Contact the administrator who closed the meeting to discuss options (see the [ballot reset runbook section](#ballot-reset-emergency-only) if applicable).

### Step 2: Identify lot owners to enter votes for

Navigate to **Meetings → [Meeting Name] → Results** to see which lot owners have not yet voted. Download or note their `lot_owner_id` values from the lot owner list.

Alternatively, use the API directly:

```bash
curl -s https://<deploy-url>/api/admin/buildings/<building_id>/lot-owners \
  -H "Cookie: <admin-session-cookie>"
```

### Step 3: Submit the vote batch via the admin portal

Navigate to **Meetings → [Meeting Name] → Enter Votes** in the admin portal and complete the form.

Or use the API:

```bash
curl -X POST https://<deploy-url>/api/admin/general-meetings/<meeting_id>/enter-votes \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin-session-cookie>" \
  -d '{
    "votes": [
      {
        "lot_owner_id": "<uuid>",
        "motion_votes": [
          {"motion_id": "<motion_uuid>", "choice": "for"},
          {"motion_id": "<motion_uuid>", "choice": "against"}
        ]
      }
    ]
  }'
```

**Valid choice values:** `"for"`, `"against"`, `"abstain"`, `"not_eligible"`

Expected response (HTTP 200):

```json
{"submitted_count": 1, "skipped_count": 0}
```

`skipped_count` is non-zero when a lot owner already voted — the existing ballot is preserved and not overwritten.

### Step 4: Verify the votes were recorded

Navigate to **Meetings → [Meeting Name] → Results** and confirm the newly submitted lot owners now appear in the tally.

---

## 2. Per-Motion Voting Windows — Opening and Closing Individual Motions

Each motion in a meeting has a visibility flag (`is_visible`) and an open/closed state. Use these controls to manage which motions are available for voting at any given time during the meeting.

### Opening a motion (making it visible)

A motion must be **visible** before voters can cast a ballot for it.

In the admin portal, navigate to **Meetings → [Meeting Name] → Motions**, locate the motion, and click **Show**. Or via API:

```bash
curl -X PATCH https://<deploy-url>/api/admin/motions/<motion_id>/visibility \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin-session-cookie>" \
  -d '{"is_visible": true}'
```

Expected response (HTTP 200): updated motion object with `is_visible: true`.

**Error conditions:**

| Status | Meaning |
|--------|---------|
| 404 | Motion not found |
| 409 | Meeting is closed — cannot change visibility on a closed meeting |
| 409 | Attempting to hide a motion that already has votes |

### Closing a motion (locking voting for that motion)

To prevent further votes on a specific motion without closing the entire meeting:

```bash
curl -X POST https://<deploy-url>/api/admin/motions/<motion_id>/close \
  -H "Cookie: <admin-session-cookie>"
```

Expected response (HTTP 200): updated motion object with `status: "closed"` (or equivalent closed state).

**Error conditions:**

| Status | Meaning |
|--------|---------|
| 404 | Motion not found |
| 409 | Motion is already closed, is hidden, or the meeting is not open |

### Hiding a motion

If a motion was added in error and has **not yet received any votes**, it can be hidden:

```bash
curl -X PATCH https://<deploy-url>/api/admin/motions/<motion_id>/visibility \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin-session-cookie>" \
  -d '{"is_visible": false}'
```

**Note:** If any lot owner has already voted on the motion, the hide request returns **409 Conflict**. You cannot hide a motion with votes without first resetting all ballots for the meeting (destructive — see [ballot reset](#ballot-reset-emergency-only) below).

---

## 3. Error Recovery — Admin Vote Entry Fails Mid-Batch

If the admin vote entry endpoint returns an error (network failure, 5xx, or 422) partway through a large batch:

### Step 1: Determine which votes were recorded

The endpoint is atomic per-call — either the entire call succeeds or it fails with no changes written to the database. If you received a non-200 response, **no votes from that call were saved**.

Check the results page to see which lot owners already have votes recorded.

### Step 2: Identify unsubmitted lot owners

Cross-reference the lot owner list against the results to find the lot owners whose votes were not recorded.

### Step 3: Resubmit only the missing votes

Build a new `votes` array containing only the lot owners who still have no ballot, and re-call the enter-votes endpoint.

Lot owners who already voted will appear in `skipped_count` — their existing ballots are safe.

### Step 4: Handle 409 — meeting was closed during entry

If the meeting was closed between starting and completing the batch:

1. Do **not** reopen the meeting — reopening is not supported.
2. If the remaining unrecorded votes are material to the outcome, escalate to the building manager immediately.
3. Document which lot owners could not submit due to the timing issue.
4. If a decision must be reversed due to missing votes, consult legal counsel for the body corporate.

### Step 5: Handle 422 — invalid lot_owner_id or unknown motion_id

The endpoint validates all `lot_owner_id` and `motion_id` values before writing anything. If you receive a 422:

1. Check the error detail for which field is invalid.
2. Verify the `lot_owner_id` belongs to the correct building and meeting.
3. Verify the `motion_id` belongs to the meeting you are submitting for.
4. Correct the payload and retry the full batch.

---

## Ballot Reset (Emergency Only)

Resetting ballots deletes **all submitted votes** for the meeting and cannot be undone. This should only be performed in test environments or under explicit instruction from the building manager.

```bash
curl -X DELETE https://<deploy-url>/api/admin/general-meetings/<meeting_id>/ballots \
  -H "Cookie: <admin-session-cookie>"
```

This endpoint is protected by admin auth and is intended for E2E test setup only.

---

## Related Runbooks

- [`docs/runbooks/smoke-test.md`](smoke-test.md) — Post-deployment smoke testing
- [`docs/runbooks/email-delivery-failures.md`](email-delivery-failures.md) — Email delivery troubleshooting after meeting close

---

## References

- API endpoint: `POST /api/admin/general-meetings/{id}/enter-votes`
- API endpoint: `PATCH /api/admin/motions/{id}/visibility`
- API endpoint: `POST /api/admin/motions/{id}/close`
- PRD story: US-AVE-01 through US-AVE-03
