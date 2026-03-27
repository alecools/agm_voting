# Runbook: Email Delivery Failures

Use this runbook when the AGM results email has not been delivered after meeting close.

---

## Identifying email delivery failures

### Via admin portal

After closing a meeting, check for a persistent error banner in the admin portal under the meeting detail page. The banner appears when `EmailDelivery.status = "failed"`.

### Via debug endpoint

```bash
curl -H "Cookie: admin_session=..." https://agm-voting.vercel.app/api/admin/debug/email-deliveries
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

The email service uses exponential back-off with up to 30 retries. Retries are triggered by subsequent requests to the app (the retry scheduler runs on each request). If the deployment is receiving no traffic, retries may not fire.

**To manually trigger a retry:**

```bash
# Replace {meeting_id} with the UUID from the debug endpoint
curl -X POST \
  -H "Cookie: admin_session=..." \
  https://agm-voting.vercel.app/api/admin/general-meetings/{meeting_id}/resend-report
```

This transitions the delivery status back to `pending` and schedules an immediate retry.

---

## Common causes

| Cause | `last_error` example | Resolution |
|-------|---------------------|------------|
| Invalid SMTP credentials | `Authentication failed` | Update `SMTP_USERNAME` / `SMTP_PASSWORD` in Vercel env vars |
| SMTP server unreachable | `Connection refused` / `timeout` | Check SMTP host availability; verify `SMTP_HOST` and `SMTP_PORT` env vars |
| Invalid recipient email | `550 No such user` | Update the manager email on the building record in the admin portal |
| Email content too large | `552 Message too large` | Check for unusually large meeting reports (many motions) |
| Rate limiting | `421 Too many connections` | Wait and retry; consider upgrading SMTP plan |

---

## Checking SMTP configuration

Verify the following environment variables in the Vercel dashboard (Settings → Environment Variables):

- `SMTP_HOST` — e.g. `smtp.resend.com`
- `SMTP_PORT` — e.g. `587`
- `SMTP_USERNAME` — e.g. `resend` or your SMTP username
- `SMTP_PASSWORD` — the SMTP API key or password
- `SMTP_FROM_EMAIL` — the sender email address

---

## Escalation

If manual retry fails and SMTP credentials are confirmed correct:

1. Check the SMTP provider dashboard (e.g. Resend) for delivery status and bounce reasons.
2. If the recipient email is permanently invalid, update the building's manager email via the admin portal and retry.
3. As a last resort, export the meeting results from `GET /api/admin/general-meetings/{id}` and email the report manually.
