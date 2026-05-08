# SRE Operational Readiness Review

**Date:** 2026-03-31
**Reviewer:** SRE / Reliability Engineer
**Status:** Review Complete

---

## Executive Summary

The AGM Voting App demonstrates **strong operational foundations** with well-defined SLOs, comprehensive runbooks, and thoughtful infrastructure design. However, **five critical gaps** require immediate attention before production deployment:

1. **No alerting system** — SLOs defined but no alerting rules or monitoring integration
2. **Email retry mechanism is not background-persistent** — retries only fire on request traffic
3. **Inadequate observability for DB pool exhaustion** — no proactive alerts on connection pressure
4. **Missing deployment validation checklist** — post-deployment smoke tests not automated
5. **Incomplete disaster recovery testing** — DR drill schedule declared but process not fully documented

---

## Findings by Severity

### CRITICAL

#### 1. No Alerting Infrastructure — Alert routing undefined
**Issue:** SLOs are defined but no alerting rules, monitoring integration, or escalation paths exist.

**File:** `docs/slo.md` lines 1-62
**Details:**
- Availability target: 99.5% (3.6 hrs downtime per 30 days)
- Latency SLOs defined (p50/p99 targets across 6 endpoints)
- Email delivery target: 2 minutes under normal SMTP
- **No integration with monitoring system** — Vercel logs are the only observation layer
- **No alert rules** — no one is automatically notified on SLO breach
- **No escalation policy** — who owns which incident type is undefined
- **No on-call rotation** — no schedule for who responds to alerts

**Impact:** SLO breaches go undetected for hours. Critical incidents (DB down, email provider down) have no automated notification.

**Recommendation:**
1. Integrate Vercel runtime logs with a monitoring system (e.g., Datadog, New Relic, CloudWatch)
2. Define alert thresholds:
   - Error rate > 1% for 5 minutes → page on-call
   - `/api/health` returns 503 → immediate page
   - Email delivery status = `failed` → urgent alert
   - DB connection pool utilization > 80% → warning
3. Create on-call schedule with escalation policy
4. Add alert rules to infrastructure-as-code (GitHub Actions or Terraform)

---

#### 2. Email Retry Mechanism Is Request-Triggered, Not Background-Persistent
**Issue:** Email retry scheduler depends on incoming request traffic. During quiet periods, retries do not fire.

**File:** `backend/app/services/email_service.py` lines 176–306
**Details:**
- `trigger_with_retry()` runs as an asyncio background task spawned on request handling
- On app startup, `requeue_pending_on_startup()` relaunches pending deliveries (line 286–306)
- **No persistent background job system** — retries only fire if requests arrive
- **No guarantee of retry cadence** — if an AGM closes and traffic ceases, retries may never fire
- `_MAX_ATTEMPTS = 30` with exponential backoff (2^attempt, capped at 3600s)
- After 30 failures, status = `failed` but no escalation to operator

**Impact:** Email reports for AGMs that close during off-peak hours may never be delivered, violating the 2-minute SLO.

**Example failure scenario:**
1. Meeting closes at 18:00 on Friday
2. Email send fails (SMTP provider temporary outage)
3. System enters `pending` status, scheduled to retry in 2 seconds
4. No requests arrive over the weekend
5. Retry tasks never fire
6. On Monday morning, email is still in `pending` status after 72 hours

**Recommendation:**
1. **Migrate to persistent background jobs:**
   - Use a cronjob to poll for pending `EmailDelivery` records every 5 minutes
   - Spawn retry tasks from the cron handler, not from request handlers
   - Example: Vercel cron function or external service (AWS EventBridge, CloudScheduler)

2. **Or implement a fallback escalation:**
   - Create an endpoint `/api/admin/email-deliveries/check-stalled` that finds pending deliveries older than 10 minutes
   - Call this endpoint from a cronjob every 10 minutes
   - Emit `ERROR`-level alert if any are found

3. **Add observability:**
   - Emit structured log `event=email_retry_scheduled` with `next_retry_at` and `delay_seconds`
   - Log `event=email_retry_backoff_exhausted` when max attempts reached
   - Create alert: if any delivery remains `pending` for > 15 minutes, escalate

**Code location:** `backend/app/services/email_service.py:306` — `asyncio.create_task()` spawns task on request, not on schedule

---

#### 3. Missing Observability for DB Connection Pool Exhaustion
**Issue:** No proactive alerts on connection pool pressure; problem only discovered when requests fail.

**File:** `backend/app/database.py` lines 11–37
**Details:**
- Pool configured: `pool_size=2, max_overflow=3, pool_timeout=10`
- Per-Lambda capacity: 5 connections (pool_size + max_overflow)
- Neon hard limit: ~25 connections
- **No metrics exported** for current pool utilization
- **No alert** on pool_timeout (timeout happens silently, request fails with 503)
- Debug endpoint `/api/admin/debug/db-health` exists but must be polled manually
- Connection pressure only visible post-mortem in Neon console

**Impact:**
- Pool exhaustion causes cascading request failures
- No warning before limit is reached
- Operator discovers issue when users report errors, not proactively

**Recommendation:**
1. Export pool metrics on each request:
   - Add middleware that records `db.pool.checked_in`, `db.pool.checked_out`, `db.pool.overflow` to structured logs
   - Example: `logger.info("db_pool_status", checked_in=2, checked_out=1, overflow=0, timeout_sec=10)`

2. Create alert thresholds:
   - `checked_out >= 4` (80% of max capacity) → warning
   - `checked_out == 5` (at capacity) → alert
   - `pool_timeout_error` occurs → immediate page

3. Document scaling procedure:
   - If alert fires consistently during peak load:
     - Increase `pool_size` or `max_overflow` (with analysis of Neon connection limit impact)
     - Or scale Neon to higher tier with more connections

**Code location:** `backend/app/database.py:33-35` — pool settings; no instrumentation

---

#### 4. Automated Deployment Validation (Post-Merge Smoke Tests) Not Defined
**Issue:** No automated checklist to verify deployments succeeded. Manual verification required.

**File:** `.github/workflows/ci.yml` lines 1–100
**Details:**
- Branch CI runs (pytest, security scans, migrations)
- E2E tests run on preview deployment
- **No post-merge smoke test workflow** defined
- **No automated verification** that production deployment is healthy
- `docs/runbooks/app-down.md` step 2 says "Log in to vercel.com" — manual process
- Health checks exist (`/api/health`, `/api/health/live`) but are not called from CI

**Impact:**
- Bad deployments may reach production undetected
- If a deployment breaks core functionality, it can stay broken for hours
- Operator must manually discover and investigate

**Recommendation:**
1. Create post-merge smoke test workflow (triggered on merge to `preview` and `master`):
   ```yaml
   - name: Smoke tests
     run: |
       ENDPOINT="https://vms-demo.ocss.tech"  # or preview URL

       # Full health check
       curl -f "$ENDPOINT/api/health" || exit 1

       # Liveness probe
       curl -f "$ENDPOINT/api/health/live" || exit 1

       # Test OTP request (with dummy email)
       curl -X POST "$ENDPOINT/api/auth/request-otp" \
         -H "Content-Type: application/json" \
         -d '{"email":"test@example.com","building_id":"...","general_meeting_id":"..."}' \
         || exit 1
   ```

2. Add deployment validation to CI pipeline (after Vercel deployment completes)
3. Store smoke test results and link from PR

---

### HIGH

#### 5. Email Delivery Retry State Not Observable Until Manual Escalation
**Issue:** Failed email deliveries are visible only via manual admin portal query or debug endpoint.

**File:** `backend/app/services/email_service.py` lines 214–264, `docs/runbooks/email-delivery-failures.md` lines 10–23
**Details:**
- Email delivery status: `pending` → `delivered` or `failed`
- On failure after 30 retries, status = `failed` (line 252)
- Structured log emitted: `event=email_delivery_attempt` with `status="failed"` (line 257)
- **No proactive alert** when status transitions to `failed`
- Operator must check admin portal after every meeting close
- Debug endpoint exists but requires manual polling

**Impact:** Failed email deliveries go unnoticed until someone manually checks the admin portal.

**Recommendation:**
1. Add alert condition in monitoring system:
   - Query: `event=email_delivery_attempt AND status=failed`
   - Alert: "Email delivery failed after 30 retries for AGM {agm_id}"
   - Severity: High (but not page-worthy if occurs < once per day)

2. Add admin portal notification:
   - On `/api/admin/general-meetings/{id}` response, include `email_delivery_status` field
   - Display banner if status = `failed`

3. Implement manual retry:
   - Endpoint exists: `POST /api/admin/general-meetings/{id}/resend-report`
   - Document in runbook: "Run this to manually trigger a retry after fixing SMTP config"

**Code location:** `backend/app/services/email_service.py:256-263`

---

#### 6. DB Connection Pool Capacity Ceiling Not Documented in Runbooks
**Issue:** Capacity planning information exists in code comments but not in operator-facing docs.

**File:** `docs/runbooks/database-connectivity.md` lines 52–53
**Details:**
- Runbook states: "With pool_size=2 + max_overflow=3 = 5 connections per Lambda and ~25-connection Neon limit, the app can support up to 5 concurrent Lambda instances"
- **This is a hard ceiling** — not clearly stated as "maximum concurrent Lambdas"
- **No procedure documented** for what to do when hitting this limit
- Scaling options not listed (increase pool_size? upgrade Neon? both?)

**Impact:** When load increases and connection pressure begins, operator has no clear scaling path.

**Recommendation:**
1. Add "Capacity Planning" section to `database-connectivity.md`:
   ```markdown
   ## Capacity Planning

   **Current ceiling:** 5 concurrent Lambda instances (5 connections/instance × 5 = 25 total)

   **When to scale:**
   - If `db.pool.checked_out >= 4` alert fires regularly (> 10x per day)
   - Or if `/api/health` returns 503 with pool timeout during peak load

   **Scaling options (in order of preference):**
   1. Increase Neon plan from Starter (~25 connections) to Growth (~100 connections)
      - Cost: ~$0.50/day per growth tier
      - Impact: Supports up to 20 concurrent Lambdas
   2. Increase `db_pool_size` and `db_max_overflow` in settings
      - Cost: Marginal (fewer database round-trips)
      - Risk: May still hit Neon limit if not paired with plan upgrade
   3. Enable Neon's connection pooler (PgBouncer mode)
      - Cost: Additional setup
      - Benefit: Multiplexes many app connections to fewer DB connections
   ```

2. Add scaling decision tree to `docs/runbooks/app-down.md`

**Code location:** `backend/app/config.py:29-34`; `docs/runbooks/database-connectivity.md:52-54`

---

#### 7. Disaster Recovery Drill Schedule Declared But Not Executed
**Issue:** DR drills are required quarterly but execution process and tools are incomplete.

**File:** `docs/runbooks/disaster-recovery.md` lines 121–133
**Details:**
- DR RTO: 2 hours (acceptable)
- DR RPO: 1 hour (acceptable; based on Neon PITR granularity)
- Manual recovery steps documented (lines 26–115)
- **Drill schedule declared but no tracking mechanism** (line 133: "Quarterly from the date of this document's creation")
- **No runbook for conducting the drill** — operator must interpret manual steps and convert to drill procedure
- **No record of past drills** — cannot verify if procedure works or how long it takes
- **Neon PITR recovery depends on manual URL copying and transformation** — error-prone, no automation

**Impact:**
- When real disaster strikes, recovery procedure may be broken or outdated
- No data on actual RTO/RPO achieved in practice
- Operator lacks confidence in recovery capability

**Recommendation:**
1. Create `docs/runbooks/dr-drill.md` with automated procedure:
   ```bash
   #!/bin/bash
   # disaster-recovery-drill.sh

   set -e

   DRILL_NAME="dr-drill-$(date +%Y-%m-%d-%H%M%S)"
   RECOVERY_TIMESTAMP=$(date -u -v -1H +"%Y-%m-%dT%H:%M:%SZ")  # 1 hour ago

   echo "Starting DR drill: $DRILL_NAME"
   echo "Recovery point: $RECOVERY_TIMESTAMP"

   # Step 1: Create restore branch in Neon
   # (Neon API call to create branch with timestamp)

   # Step 2: Extract connection string
   # (curl to Neon API, parse response)

   # Step 3: Run migrations
   # DB="..."
   # alembic -x dburl="$DB" upgrade head

   # Step 4: Deploy to non-prod Vercel preview
   # (curl to Vercel to create env var for drill)

   # Step 5: Run smoke tests
   # (curl health checks)

   # Step 6: Record result
   # (append to docs/drills.log)

   # Step 7: Cleanup
   # (delete Neon branch, delete Vercel env var)
   ```

2. Add quarterly calendar reminder (e.g., GitHub issue template that auto-opens on schedule)
3. Create `docs/drills.log` to track:
   - Date of drill
   - Time to recovery (minutes)
   - Issues encountered
   - Runbook updates needed

**Code location:** `docs/runbooks/disaster-recovery.md:121-133`

---

#### 8. Build-Time DB Migrations Lack Verification of Migration Success
**Issue:** Alembic migrations run during Vercel build, but failure handling is incomplete.

**File:** `vercel.json` line 3; `CLAUDE.md` lines 95–96; `api/index.py` (auto-open/close logic)
**Details:**
- Build command: `cd frontend && npm install && npx vite build && cp -r dist ../api/static && bash ../scripts/migrate.sh`
- Migrations run via `alembic upgrade head` in `migrate.sh` (not shown in review)
- **If migration fails, Vercel build should fail** (desired, per CLAUDE.md line 95)
- **No explicit check** that migrations completed successfully
- **Auto-open/close logic in `api/index.py:66-111` assumes migrations ran** — if migration failed but build didn't, this code runs against stale schema

**Impact:** If migration script has bugs or Neon connection fails during build, Lambda may start with incomplete schema, causing runtime errors.

**Recommendation:**
1. Add explicit migration success verification in `api/index.py`:
   ```python
   # At startup, before auto-open/close logic:
   async def _verify_migrations() -> None:
       """Verify migrations are up-to-date with codebase."""
       from alembic.config import Config
       from alembic.script import ScriptDirectory
       from alembic.runtime.migration import MigrationContext

       config = Config("alembic.ini")
       script = ScriptDirectory.from_config(config)

       async with _session_factory() as db:
           context = MigrationContext.configure(db.raw_connection())
           current_revision = context.get_current_revision()

       head_revision = script.get_heads()[0]

       if current_revision != head_revision:
           raise RuntimeError(
               f"DB schema is at {current_revision}, but codebase expects {head_revision}. "
               "Run `alembic upgrade head` to fix."
           )
   ```

2. Call this before auto-open/close logic (line 111)
3. Document: if this check fails, Lambda will exit with error, blocking the deployment

**Code location:** `vercel.json:3`; `api/index.py:66-111`

---

### MEDIUM

#### 9. Security Headers CSP Allows Unsafe-Inline for Scripts (Vite Workaround)
**Issue:** Content-Security-Policy allows `unsafe-inline` for scripts to work around Vite's module preload polyfill.

**File:** `backend/app/main.py` lines 28–30
**Details:**
- CSP: `script-src 'self' 'unsafe-inline' https://vercel.live ...`
- Comment (line 30): "unsafe-inline required for Vite module preload polyfill"
- This weakens XSS protections; any script injection vulnerability can execute arbitrary code

**Impact:** Reduces security posture. XSS vulnerabilities are not fully mitigated by CSP.

**Recommendation:**
1. **Preferred:** Work with Vite to remove need for unsafe-inline:
   - Vite 5.x may support module preload without unsafe-inline
   - Generate nonce at build time and inject into script tags
   - Example: `script-src 'self' 'nonce-{build-time-hash}' ...`

2. **Fallback:** Keep unsafe-inline but add runtime XSS mitigations:
   - Input sanitization (already done: `bleach.clean()` in admin_service.py)
   - Output encoding in templates
   - Regular XSS scanning in CI (already done: `npm run lint:security`)

**Code location:** `backend/app/main.py:28-30`

---

#### 10. Health Check Does Not Return Sufficient Detail for Debugging
**Issue:** Health check returns generic "status" but omits version, schema revision, and build timestamp.

**File:** `backend/app/main.py` lines 90–106
**Details:**
- Response: `{"status": "ok", "db": "connected"}`
- Missing: deployment version, migration state, build timestamp
- Operator cannot determine if a deployment contains a specific fix without checking Vercel dashboard

**Impact:** Debugging deployment issues requires cross-referencing multiple systems.

**Recommendation:**
1. Enhance `/api/health` response:
   ```json
   {
     "status": "ok",
     "db": "connected",
     "version": "0.2.1",           # from git tag or package.json
     "build_timestamp": "2025-03-31T14:22:00Z",
     "migrations_current": "abc123xyz...",  # alembic current revision
     "environment": "production"
   }
   ```

2. Add read-only endpoint `/api/admin/debug/version` (admin auth required) for detailed info

**Code location:** `backend/app/main.py:90-106`

---

#### 11. OTP Email Delivery Lacks Rate-Limit Backoff
**Issue:** OTP emails sent via aiosmtplib with no retry or backoff on SMTP failures.

**File:** `backend/app/services/email_service.py` lines 75–103
**Details:**
- `send_otp_email()` calls `aiosmtplib.send()` with no error handling
- If SMTP fails, the endpoint returns 500 (caught by middleware)
- Voter sees error; no automatic retry
- If rate-limited by SMTP provider, all subsequent OTP requests fail until provider resets

**Impact:** During SMTP outages, voters cannot log in. No graceful degradation.

**Recommendation:**
1. Add retry logic to `send_otp_email()`:
   ```python
   max_retries = 3
   backoff_seconds = [1, 2, 4]  # 1s, 2s, 4s

   for attempt, delay in enumerate(backoff_seconds):
       try:
           await aiosmtplib.send(...)
           return
       except Exception as exc:
           if attempt == len(backoff_seconds) - 1:
               raise  # re-raise on final attempt
           await asyncio.sleep(delay)
   ```

2. Add circuit breaker:
   - Track SMTP errors over 5-minute window
   - If > 10 failures in window, return 503 "temporarily unavailable" instead of 500
   - Document: "If OTP email fails, try again in 1 minute or contact support"

**Code location:** `backend/app/services/email_service.py:75-103`

---

#### 12. Session Middleware Uses Non-Secure Defaults in Development
**Issue:** Session cookies created with `https_only=False` when `environment != "production"`.

**File:** `backend/app/main.py` lines 66–71; `backend/app/config.py` line 27
**Details:**
- `https_only=settings.environment == "production"`
- In development/preview, session cookies sent over plain HTTP
- In preview (non-production URL), cookies are unencrypted on the wire

**Impact:** Session tokens exposed in preview environment if network is not already HTTPS.

**Recommendation:**
1. Always set `https_only=True`:
   ```python
   SessionMiddleware(
       secret_key=settings.session_secret,
       https_only=True,  # always require HTTPS
       same_site="lax",
   )
   ```

2. If local dev requires HTTP, use a dev-only mode:
   - Set `environment="local"` in dev `.env`
   - Only in local mode allow `https_only=False`

**Code location:** `backend/app/main.py:69`

---

### LOW

#### 13. Structured Logging Does Not Include Request Correlation IDs
**Issue:** Logs lack correlation IDs, making it hard to trace a single request through multiple log entries.

**File:** `backend/app/logging_config.py` lines 45–73
**Details:**
- Logging configured with structlog (good)
- Includes service name, timestamp, log level
- Missing: request ID / trace ID / correlation ID
- Related log entries across middleware and services cannot be linked

**Impact:** Debugging multi-step requests requires manual timestamp correlation.

**Recommendation:**
1. Generate request ID on entry:
   ```python
   # In middleware:
   request.state.request_id = str(uuid.uuid4())
   ```

2. Inject into all log entries:
   ```python
   logger.bind(request_id=request.state.request_id).info("...")
   ```

3. Include in response headers for client-side correlation:
   ```python
   response.headers["X-Request-ID"] = request.state.request_id
   ```

**Code location:** `backend/app/logging_config.py`; `backend/app/main.py`

---

#### 14. No Backup Strategy Defined for Non-DB Data
**Issue:** Neon PITR protects DB but file uploads (via blob_service.py) lack backup documentation.

**File:** `backend/app/services/blob_service.py` (not reviewed in detail)
**Details:**
- Application may store files (e.g., lot owner import files)
- Neon PITR covers database
- File storage strategy unknown (local disk? S3? etc.)
- No backup or disaster recovery plan for files

**Impact:** File loss not covered by DR plan.

**Recommendation:**
1. Document file storage location and backup strategy in `docs/runbooks/disaster-recovery.md`
2. If using Vercel's serverless platform:
   - Files stored on local Lambda filesystem are ephemeral (lost on cold start)
   - Migrate to persistent storage: Vercel Storage (KV, Postgres), AWS S3, etc.
3. Include file backup in quarterly DR drill

**Code location:** `backend/app/services/blob_service.py`

---

## Operational Readiness Checklist

| Item | Status | Notes |
|------|--------|-------|
| SLOs defined | ✅ | 99.5% availability, latency targets documented |
| Alerting rules configured | ❌ | No monitoring integration; requires setup |
| On-call rotation established | ❌ | Not defined |
| Runbooks written | ✅ | Comprehensive (app-down, DB connectivity, email, DR) |
| Health checks implemented | ✅ | `/api/health` and `/api/health/live` defined |
| Post-deployment smoke tests | ❌ | Manual only; not automated |
| DB backup/recovery tested | ⚠️ | Procedure documented; drill not yet executed |
| Email retry mechanism | ⚠️ | Works but depends on request traffic |
| Security headers configured | ✅ | CSP strict except for unsafe-inline (Vite workaround) |
| Structured logging | ✅ | JSON output; missing request correlation IDs |
| Connection pool monitoring | ❌ | No metrics exported or alerts |
| Rate limiting implemented | ✅ | OTP requests rate-limited; email lacks backoff |
| Incident response plan | ⚠️ | Runbooks exist; no escalation policy defined |

---

## Deployment Readiness

**Before deploying to production:**

1. **CRITICAL:** Set up alerting (findings #1)
   - Choose monitoring platform
   - Define alert rules for availability and latency
   - Establish on-call schedule

2. **CRITICAL:** Make email retry mechanism background-persistent (finding #2)
   - Implement cron-based retry trigger
   - Add observability for retry state

3. **CRITICAL:** Add DB pool observability (finding #3)
   - Export pool metrics in logs
   - Set up alerts on pool utilization

4. **HIGH:** Automate post-deployment smoke tests (finding #4)
5. **HIGH:** Execute first quarterly DR drill (finding #7)

---

## Post-Deployment Monitoring Strategy

| Metric | Collection | Alert Threshold | Owner |
|--------|-----------|---|---|
| Availability (99.5% target) | `/api/health` success rate | < 99% over 1 hour | On-call |
| Latency p99 (< 2s) | FastAPI logs | > 2.5s for 5 min | On-call |
| Email delivery (< 2 min) | `EmailDelivery.status` | > 5 min for any delivery | On-call |
| DB connection exhaustion | Pool metrics | checked_out ≥ 4 | On-call |
| Error rate | 5xx response codes | > 1% over 5 min | On-call |
| Migration state | App startup check | Schema mismatch | Build CI |

---

## References

- SLO definition: `docs/slo.md`
- Runbooks: `docs/runbooks/`
- Health endpoints: `backend/app/main.py:90-115`
- DB configuration: `backend/app/database.py`
- Email service: `backend/app/services/email_service.py`
- Vercel config: `vercel.json`
