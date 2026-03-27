# Incident Response Runbook

## Severity Levels

| Level | Description | Response Time | Examples |
|-------|-------------|---------------|---------|
| **P0 — Critical** | Service completely unavailable during an active AGM window | Immediate (< 15 min) | App returns 5xx for all requests; DB unreachable; voters cannot submit ballots |
| **P1 — High** | Core flow degraded but partially functional | < 1 hour | Email delivery failing; auth slow; admin cannot close meeting |
| **P2 — Medium** | Non-critical feature broken | < 4 hours | Report view broken; import failing; debug endpoints unavailable |
| **P3 — Low** | Cosmetic or minor issue | Next business day | UI display glitch; minor performance degradation |

---

## Escalation Steps

### P0 — Critical

1. **Assess scope** — Check `GET /api/health` and `GET /api/health/live` to distinguish DB failure from process failure.
2. **Check Vercel** — Visit the Vercel dashboard for the relevant branch deployment. Check function logs for errors.
3. **Check Neon** — Log in to `console.neon.tech`, check the project `divine-dust-41291876` for connection errors or high usage.
4. **Roll back if needed** — If a recent deploy caused the issue, revert via Vercel dashboard → Deployments → previous deployment → Promote.
   - Note: Alembic migrations are **not** auto-reverted. If the migration caused the issue, a compensating migration must be written and deployed.
5. **Communicate** — Notify meeting organiser(s) of the issue and estimated resolution time.
6. **Post-incident** — Write a brief incident report within 24 hours covering: timeline, root cause, resolution, and prevention.

### P1 — High

1. Check Vercel function logs for error patterns.
2. Use debug endpoints (`GET /api/admin/debug/db-health`, `GET /api/admin/debug/email-deliveries`) to diagnose.
3. If email is failing: see `docs/runbooks/email-delivery-failures.md`.
4. If DB is slow: see `docs/runbooks/database-connectivity.md`.

### P2 / P3

1. Log in Vercel function logs.
2. Create a GitHub issue with reproduction steps.
3. Schedule fix in next sprint.

---

## Contacts

- Vercel project: `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L`
- Neon project: `divine-dust-41291876`
- Credentials: macOS Keychain under service `agm-survey`

---

## Key URLs

| Resource | URL |
|----------|-----|
| Production app | `https://agm-voting.vercel.app` |
| Health check | `https://agm-voting.vercel.app/api/health` |
| Vercel dashboard | `https://vercel.com/ocss/agm-voting` |
| Neon console | `https://console.neon.tech/app/projects/divine-dust-41291876` |
