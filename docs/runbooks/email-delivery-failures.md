# Runbook: Email Delivery Failures

Use this runbook when the AGM results email has not been delivered after meeting close.

---

## Identifying email delivery failures

### Via admin portal

After closing a meeting, check for a persistent error banner in the admin portal under the meeting detail page. The banner appears when `EmailDelivery.status = "failed"`.

### Via debug endpoint

```bash
curl -H "Cookie: admin_session=..." https://vms-demo.ocss.tech/api/admin/debug/email-deliveries
```

Response fields:
- `status`: `pending` | `delivered` | `failed`
- `total_attempts`: number of send attempts made
- `last_error`: the most recent error message from the SMTP service
- `updated_at`: when the record was last modified

### Via Vercel function logs

Search for `event=email_delivery_failed` in Vercel function logs. This structured log event is emitted when all retry attempts are exhausted.

---

## Retry mechanism

The email service uses exponential back-off with up to 30 attempts. On each Lambda cold start, `requeue_pending_on_startup` finds deliveries where `status='pending'` **and** `next_retry_at <= now` and fires background tasks for them (non-blocking — startup completes before retries finish).

**Non-retryable failures:** SMTP authentication errors (535) are treated as permanent and marked `status='failed'` immediately — they do not retry. Fix credentials first, then use the manual retry endpoint.

**Stale pending emails from E2E test runs** accumulate and get requeued on every cold start. Clean them up with:

```sql
DELETE FROM email_deliveries
WHERE status = 'pending'
  AND general_meeting_id IN (
    SELECT id FROM general_meetings
    WHERE title SIMILAR TO '(WF|E2E|Test|Delete Test|SESS|NMB|LS|TCG)%'
  );
```

**To manually trigger a retry:**

```bash
# Replace {meeting_id} with the UUID from the debug endpoint
curl -X POST \
  -H "Cookie: admin_session=..." \
  https://vms-demo.ocss.tech/api/admin/general-meetings/{meeting_id}/resend-report
```

This transitions the delivery status back to `pending` with `next_retry_at=null` and fires an immediate retry.

---

## Common causes

| Cause | `last_error` example | Resolution |
|-------|---------------------|------------|
| Invalid SMTP credentials | `Authentication failed` | Update credentials in Admin → Settings → Mail server |
| SMTP server unreachable | `Connection refused` / `timeout` | Check SMTP host availability; verify host/port in Admin → Settings |
| Invalid recipient email | `550 No such user` | Update the manager email on the building record in the admin portal |
| Email content too large | `552 Message too large` | Check for unusually large meeting reports (many motions) |
| Rate limiting | `421 Too many connections` | Wait and retry; consider upgrading SMTP plan |

---

## Checking SMTP configuration

SMTP settings are stored in the database (not environment variables) and configured via **Admin → Settings → Mail server**. To update or verify:

1. Log in to the admin portal → Settings → Mail server
2. Check/update host, port, username, password, and from-address
3. Save — the change takes effect on the next email attempt

To inspect the current settings without logging in:

```bash
curl -H "Cookie: admin_session=..." \
  https://vms-demo.ocss.tech/api/admin/debug/smtp-config
```

---

## Escalation

If manual retry fails and SMTP credentials are confirmed correct:

1. Check the SMTP provider dashboard (e.g. Resend) for delivery status and bounce reasons.
2. If the recipient email is permanently invalid, update the building's manager email via the admin portal and retry.
3. As a last resort, export the meeting results from `GET /api/admin/general-meetings/{id}` and email the report manually.
