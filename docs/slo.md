# Service Level Objectives (SLOs)

## Overview

This document defines the service level objectives for the AGM Voting App. SLOs are measured over a rolling 30-day window.

**Error budget:** 99.5% availability — equivalent to approximately 3.6 hours of downtime per 30-day period.

---

## Availability SLO

| Service | Target | Measurement |
|---------|--------|-------------|
| Overall application uptime | 99.5% | Health check (`GET /api/health`) success rate |
| During active AGM windows | 99.9% | Same, elevated during scheduled AGM events |

An "AGM window" is defined as the period from `meeting_at` to `voting_closes_at` plus 2 hours after close.

---

## Latency SLOs

| Endpoint | p50 target | p99 target | Notes |
|----------|-----------|-----------|-------|
| `POST /api/auth/verify` (OTP verify) | < 500 ms | < 2 s | Includes DB lookup and OTP validation |
| `POST /api/auth/request` (OTP request) | < 500 ms | < 2 s | Includes email send via SMTP |
| `POST /api/agm/{id}/submit` (ballot submission) | < 500 ms | < 1 s | Critical voter-facing path |
| `GET /api/health` | < 100 ms | < 500 ms | Must include DB connectivity check |
| `POST /api/admin/general-meetings/{id}/close` | < 5 s | < 30 s | Includes email send; acceptable for admin-only action |
| Email report delivery after close | — | < 2 min | Under normal SMTP conditions; see email SLO below |

---

## Email Delivery SLO

- Results email is delivered within **2 minutes** of meeting close under normal SMTP conditions.
- If the initial send fails, the retry scheduler retries up to 30 times with exponential back-off.
- If all 30 retries fail (`EmailDelivery.status = failed`), an `ERROR`-level structured log event is emitted and the admin portal shows a persistent error banner.

---

## Measurement Window

- **Rolling 30 days** — SLOs are evaluated against the most recent 30 calendar days.
- SLO breaches are tracked via Vercel function logs and the `GET /api/health` endpoint.

---

## Error Budget Policy

- When the error budget is more than 50% consumed in a 30-day window, all non-critical deployments are paused until the budget recovers.
- When the error budget is fully consumed, only P0 fixes are deployed.

---

## References

- Health check endpoint: `GET /api/health` — returns `{"status": "ok", "db": "connected"}` when healthy.
- Liveness probe: `GET /api/health/live` — always returns 200 (process-level check only).
- Incident runbooks: `docs/runbooks/`
