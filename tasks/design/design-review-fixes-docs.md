# Design: Documentation and SRE Review Fixes

**Status:** Draft

This design covers fixes identified during the engineering review: stale IDs/URLs in runbooks, missing alerting guidance in the SLO doc, and a misleading empty `__table_args__` in `vote.py`.

---

## Overview

Four categories of issues to address:

1. **ARCH-1 (Critical):** Wrong Neon and Vercel project IDs, plus stale production URLs, across multiple runbooks.
2. **SRE-1 (Medium):** SLO doc has no concrete monitoring/alerting guidance.
3. **LEGAL-2 (Medium):** `data-retention.md` exists but needs a retention-period summary table and cleanup SQL reference.
4. **CODE-5 (Low):** Empty `__table_args__ = ()` in `vote.py` needs a comment naming the migration file.

No schema changes. No frontend changes. No new API endpoints.

---

## Files to Change

| File | Change |
|------|--------|
| `docs/runbooks/incident-response.md` | Replace stale Neon ID, Vercel ID, and production URLs |
| `docs/runbooks/app-down.md` | Replace stale Neon console URL and Vercel dashboard URL |
| `docs/runbooks/disaster-recovery.md` | Replace stale Neon console URL and Vercel project ID |
| `docs/runbooks/database-connectivity.md` | Replace stale production app URL |
| `docs/runbooks/email-delivery-failures.md` | Replace stale production app URLs |
| `docs/runbooks/sre-review-findings.md` | Replace stale production app URL in example snippet |
| `docs/slo.md` | Add "Alerting" section before References |
| `docs/runbooks/data-retention.md` | Add retention summary table and cleanup SQL reference |
| `backend/app/models/vote.py` | Add migration filename to existing `__table_args__` comment |

---

## Exact Changes

### 1. `docs/runbooks/incident-response.md`

| Location | Wrong | Correct |
|----------|-------|---------|
| P0 Step 3 | `divine-dust-41291876` | `curly-lab-57416583` |
| Contacts — Neon project | `divine-dust-41291876` | `curly-lab-57416583` |
| Contacts — Vercel project | `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L` | `prj_HasiiyZJvxTj16WM1fmUv3IRZUf0` |
| Key URLs — Production app | `https://agm-voting.vercel.app` | `https://vms-demo.ocss.tech` |
| Key URLs — Health check | `https://agm-voting.vercel.app/api/health` | `https://vms-demo.ocss.tech/api/health` |
| Key URLs — Vercel dashboard | `https://vercel.com/ocss/agm-voting` | `https://vercel.com/ocss/internal-vms` |
| Key URLs — Neon console | `https://console.neon.tech/app/projects/divine-dust-41291876` | `https://console.neon.tech/app/projects/curly-lab-57416583` |

### 2. `docs/runbooks/app-down.md`

| Location | Wrong | Correct |
|----------|-------|---------|
| Step 1 liveness curl | `https://agm-voting.vercel.app/api/health/live` | `https://vms-demo.ocss.tech/api/health/live` |
| Step 1 health curl | `https://agm-voting.vercel.app/api/health` | `https://vms-demo.ocss.tech/api/health` |
| Step 2 Vercel login URL | `https://vercel.com/ocss/agm-voting` | `https://vercel.com/ocss/internal-vms` |
| Step 3 Neon console URL | `https://console.neon.tech/app/projects/divine-dust-41291876` | `https://console.neon.tech/app/projects/curly-lab-57416583` |

### 3. `docs/runbooks/disaster-recovery.md`

| Location | Wrong | Correct |
|----------|-------|---------|
| PITR Step 1 | `https://console.neon.tech/app/projects/divine-dust-41291876` | `https://console.neon.tech/app/projects/curly-lab-57416583` |
| Contacts — Neon console | `https://console.neon.tech/app/projects/divine-dust-41291876` | `https://console.neon.tech/app/projects/curly-lab-57416583` |
| Contacts — Vercel project | `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L` | `prj_HasiiyZJvxTj16WM1fmUv3IRZUf0` |

### 4. `docs/runbooks/database-connectivity.md`

| Location | Wrong | Correct |
|----------|-------|---------|
| Health check curl | `https://agm-voting.vercel.app/api/health` | `https://vms-demo.ocss.tech/api/health` |
| Pool diagnostics curl | `https://agm-voting.vercel.app/api/admin/debug/db-health` | `https://vms-demo.ocss.tech/api/admin/debug/db-health` |

### 5. `docs/runbooks/email-delivery-failures.md`

| Location | Wrong | Correct |
|----------|-------|---------|
| Debug endpoint curl | `https://agm-voting.vercel.app/api/admin/debug/email-deliveries` | `https://vms-demo.ocss.tech/api/admin/debug/email-deliveries` |
| Manual retry curl | `https://agm-voting.vercel.app/api/admin/general-meetings/...` | `https://vms-demo.ocss.tech/api/admin/general-meetings/...` |
| SMTP config curl | `https://agm-voting.vercel.app/api/admin/debug/smtp-config` | `https://vms-demo.ocss.tech/api/admin/debug/smtp-config` |

### 6. `docs/runbooks/sre-review-findings.md`

| Location | Wrong | Correct |
|----------|-------|---------|
| Smoke test code snippet comment | `https://agm-voting.vercel.app` | `https://vms-demo.ocss.tech` |

### 7. `docs/slo.md` — new Alerting section (add before References)

New section content:

```
## Alerting

### Vercel function log alerts

The application emits structured log events. Search Vercel function logs for:

- `event=email_delivery_failed` — all 30 retry attempts for a results email exhausted; manual
  intervention required (see docs/runbooks/email-delivery-failures.md)
- HTTP 5xx rate above 1% over a 5-minute window — indicates a deployment regression or DB issue
- `startup_email_requeue count=N` where N > 5 — test data not cleaned up; spurious email retries

To view logs: Vercel dashboard -> Project -> Deployments -> current deployment -> Functions tab
-> select a failing invocation -> expand the log stream.

### Uptime monitoring (recommended)

Configure a free-tier external uptime check independent of Vercel:

- Tool: Uptime Robot (https://uptimerobot.com) — free tier supports 5-minute check intervals
- Monitor URL: https://vms-demo.ocss.tech/api/health
- Expected response: HTTP 200, body {"status": "ok", "db": "connected"}
- Alert channel: email to on-call engineer or shared ops Slack channel

Setup: uptimerobot.com -> Add New Monitor -> HTTP(s) -> enter URL -> 5-minute interval
-> add alert contact.
```

### 8. `docs/runbooks/data-retention.md` — additions

Two additions to the existing file:

**a) Retention period summary table** — add at the top of the "Retention Periods" section:

```
| Data | Minimum retention | Notes |
|------|-------------------|-------|
| Votes / ballots (`ballot_submissions`, `votes`) | 7 years | Australian body-corporate law |
| Meeting records (`general_meetings`) | 7 years | Same legal requirement |
| Sessions / OTPs (`auth_otps`, `otp_rate_limits`) | 30 days | Auto-expired by application TTL |
| Email delivery logs (`email_deliveries`) | 1 year | Sufficient for SMTP audit trail |
| Active lot owner emails (`lot_owner_emails`) | Until lot sold or erasure request | GDPR legitimate interest |
```

**b) Cleanup SQL reference** — add at the end of the "Archiving Old Meetings" section:

```
### Test data cleanup

For removal of E2E test data from UAT, use the authoritative cleanup SQL documented in
`CLAUDE.md` under "Test Data Conventions". Do not use ad-hoc DELETE statements — the
authoritative approach deletes by exclusion of known real buildings to avoid accidental
deletion of production data.

Automated enforcement of retention periods is tracked as a future enhancement.
```

### 9. `backend/app/models/vote.py`

Add migration filename to the existing comment on line 40:

Current line 40:
```python
    # in the Alembic migration (same pattern as the motion_number partial index on motions).
    __table_args__ = ()
```

Change to:
```python
    # in the Alembic migration (same pattern as the motion_number partial index on motions).
    # Migration: a1b2c3d4e5f7_add_multi_choice_motion_type.py
    __table_args__ = ()
```

---

## Security Considerations

No security implications. These are documentation corrections and a code comment addition. No endpoints added or modified, no authentication changes, no new secrets.

---

## Schema Migration Required

No.

---

## E2E Test Scenarios

No E2E scenarios affected. These changes are documentation and comment fixes only. Existing E2E specs are unaffected.
