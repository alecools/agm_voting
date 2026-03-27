# Runbook: Disaster Recovery

## Objectives

| Metric | Target |
|--------|--------|
| **RTO** (Recovery Time Objective) | 2 hours — the application should be serving requests within 2 hours of a confirmed DB incident |
| **RPO** (Recovery Point Objective) | 1 hour — based on Neon's point-in-time recovery (PITR) granularity; at most 1 hour of vote submissions may be unrecoverable in the worst case |

---

## What data is at risk

Between the most recent restorable point and the incident time, the following data may be lost:

- Vote submissions (`ballot_submissions`, `votes` tables)
- OTP tokens (`auth_otps` table)
- Active session records (`session_records` table)
- Email delivery state (`email_deliveries` table)

Buildings, lot owners, and meeting/motion definitions are less frequently written and have a lower probability of loss.

---

## Neon point-in-time recovery steps

Neon provides PITR via branch creation. To restore to a point before the incident:

1. Log in to `https://console.neon.tech/app/projects/divine-dust-41291876`.

2. Navigate to **Branches** → **New Branch**.

3. Set the restore point:
   - Select the parent branch (`preview` or `main` as appropriate).
   - Enable "From timestamp" and enter the recovery timestamp (UTC) — choose the latest point before the incident.

4. Name the branch (e.g., `restore-2025-06-15-1400`).

5. Copy the **connection string** for the new branch (unpooled endpoint, `postgresql://...`).

6. Strip `channel_binding=require` and ensure `ssl=require` is present:
   ```
   postgresql+asyncpg://user:pass@ep-xxx.region.neon.tech/dbname?ssl=require
   ```

7. Verify the restored DB is in the expected state:
   ```bash
   DB="postgresql+asyncpg://user:pass@ep-xxx.../dbname?ssl=require"
   cd backend && uv run alembic -x dburl="$DB" current
   ```

---

## Re-pointing Vercel to the restored database

Once the restored Neon branch is ready, update the Vercel environment variables to point the deployment at it.

### For production (`master` branch):

```bash
vercel env rm DATABASE_URL production
vercel env add DATABASE_URL production
# Paste the new connection string when prompted

vercel env rm DATABASE_URL_UNPOOLED production
vercel env add DATABASE_URL_UNPOOLED production
# Paste the unpooled connection string when prompted
```

### For preview branches:

In the Vercel dashboard:
1. Settings → Environment Variables
2. Find `DATABASE_URL` and `DATABASE_URL_UNPOOLED`
3. Update the value for the relevant branch scope
4. Trigger a new deployment to pick up the new env vars

### Trigger a redeployment

```bash
# Force a fresh deploy using the current commit
git commit --allow-empty -m "chore: re-point to restored DB"
git push origin <branch>
```

Or use the Vercel dashboard → Deployments → **Redeploy** on the most recent deployment.

---

## Verify the restoration

After redeployment, run the smoke test checklist (see `docs/runbooks/deployment.md`):

1. `GET /api/health` returns `{"status": "ok", "db": "connected"}`
2. Admin login succeeds
3. Spot-check that expected buildings and meetings are present in the admin portal

---

## Migration state after recovery

Neon PITR restores the DB to its state at the chosen timestamp, **including migration history**. If migrations were applied between the recovery point and the incident, those migrations will not be present in the restored DB.

To check the current migration state against the restored DB:

```bash
DB="postgresql+asyncpg://user:pass@ep-xxx.../dbname?ssl=require"
cd backend && uv run alembic -x dburl="$DB" current
```

If the restored DB is behind the codebase's `alembic upgrade head`, run:

```bash
uv run alembic -x dburl="$DB" upgrade head
```

Only do this if you are certain the codebase migrations are compatible with the restored data.

---

## Quarterly DR drill schedule

A disaster recovery drill should be performed **once per quarter** to verify these steps remain accurate and the team is familiar with the process.

**Drill procedure:**

1. Create a Neon branch from `preview` at a timestamp 1 hour in the past.
2. Point a non-production Vercel preview deployment at the new branch.
3. Verify `GET /api/health` passes and spot-check the data.
4. Delete the drill branch after the exercise.
5. Record the outcome (time taken, any issues found) in the incident log.

**Next scheduled drill:** Quarterly from the date of this document's creation.

---

## Contacts and credentials

- Neon console: `https://console.neon.tech/app/projects/divine-dust-41291876`
- Vercel project: `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L`
- Neon API key: macOS Keychain → `security find-generic-password -a "neon-api-key" -s "agm-survey" -w`
- Vercel token: macOS Keychain under service `agm-survey`
