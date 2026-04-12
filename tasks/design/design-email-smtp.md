# Design: Email and SMTP Configuration

## Overview

The system sends two types of email: OTP verification codes (during voter authentication) and meeting summary reports (triggered when a meeting is closed). SMTP settings are stored encrypted in the database and managed via the admin Settings page. Email delivery is tracked via `email_deliveries` records with retry logic. Admins can resend the summary email for any closed meeting.

---

## Data Model

### `email_deliveries` table

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `general_meeting_id` | UUID FK → `general_meetings.id` CASCADE | |
| `status` | Enum(`pending`, `delivered`, `failed`) | |
| `total_attempts` | INTEGER | reset to 0 on resend |
| `last_error` | TEXT | nullable |
| `next_retry_at` | TIMESTAMPTZ | nullable |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

### `tenant_smtp_config` table

Singleton row (`id = 1`, enforced by `CHECK (id = 1)`):

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | always 1 |
| `smtp_host` | VARCHAR | NOT NULL DEFAULT '' |
| `smtp_port` | INTEGER | NOT NULL DEFAULT 587 |
| `smtp_username` | VARCHAR | NOT NULL DEFAULT '' |
| `smtp_password_enc` | VARCHAR | nullable; AES-256-GCM encrypted, base64-encoded |
| `smtp_from_email` | VARCHAR | NOT NULL DEFAULT '' |
| `updated_at` | TIMESTAMPTZ | |

Seeded by migration from `SMTP_*` env vars if present. `SMTP_ENCRYPTION_KEY` env var (base64-encoded 32-byte key) used for encryption/decryption. Old `SMTP_*` env vars are deprecated (retained only for migration seeding).

---

## API Endpoints

### `POST /api/auth/request-otp`

Triggers OTP email on successful lookup. See `design-auth.md` for full details. If SMTP is not configured, raises `SmtpNotConfiguredError` which immediately sets `EmailDelivery.status = failed` (no retry).

### `POST /api/admin/general-meetings/{id}/close`

Creates `EmailDelivery(status='pending')`. Router fires `asyncio.create_task(email_service.trigger_with_retry(meeting_id))` after the response is returned.

### `POST /api/admin/general-meetings/{id}/resend-report`

Resets the `EmailDelivery` record to `pending` (unconditionally — no longer restricted to `failed` delivery status). Also resets `total_attempts` and `last_error`. Schedules `trigger_with_retry` as a background task. Returns `{ queued: true }`. 409 if meeting is not closed. 404 if no `EmailDelivery` record found.

### SMTP configuration (admin)

| Endpoint | Description |
|---|---|
| `GET /api/admin/config/smtp` | Returns `SmtpConfigOut` (host, port, username, from_email — no password) |
| `PUT /api/admin/config/smtp` | Upserts config; `smtp_password` field is optional (null = keep existing) |
| `POST /api/admin/config/smtp/test` | Tests current config by sending a test message to `smtp_from_email`; rate-limited to 5 req/min; returns `{"ok": true}` or error detail |
| `GET /api/admin/config/smtp/status` | Returns `{"configured": bool}` — true when host, username, from_email are non-empty AND `smtp_password_enc IS NOT NULL` |

---

## Email Templates

### OTP email (`backend/app/templates/otp_email.html`)

Subject: `Your AGM Voting Code — {meeting_title}`

Contains:
- Meeting title
- The 8-character code in a large monospaced span
- "This code expires in 5 minutes. Do not share it with anyone."
- "If you did not request this code, please ignore this email."

### Meeting summary email (`backend/app/templates/report_email.html`)

Sent to `Building.manager_email` when a meeting closes. Contains per-motion results with:
- Motion title + resolution type label ("General Resolution" or "Special Resolution")
- For/Against/Abstained/Absent tally rows
- For multi-choice motions: per-option For/Against/Abstained rows with outcome badge (Pass/Fail/Tie)
- Voter lists per category (lot number + voter email + entitlement)
- Multi-choice option voter lists (collapsed per option)

---

## Frontend Components

### `SettingsPage.tsx` — Mail Server section

New "Mail Server" card below Tenant Branding:
- Fields: Host, Port (default 587), Username, From email, Password (type="password", `autocomplete="new-password"`, placeholder "Enter new password to change")
- "Save" button → `PUT /api/admin/config/smtp`
- "Send test email" button → `POST /api/admin/config/smtp/test`; shows inline success/error
- Amber inline notice when all fields are empty (unconfigured)

### `AdminLayout.tsx` — SMTP warning banner

On mount, calls `GET /api/admin/config/smtp/status`. When `configured = false`, renders a dismissible amber banner at the top of the admin content area.

### `GeneralMeetingDetailPage.tsx` — Resend button

"Resend Summary Email" button visible whenever `meeting.status === "closed"` (not only on failed delivery). Uses `resendMutation` (calls `resendReport(meetingId)`). Shows "Sending…" while pending, "Queued for resend." on success, inline error on failure.

---

## Email Delivery and Retry Logic

`EmailService.trigger_with_retry(meeting_id)`:
1. Loads `EmailDelivery` record by `general_meeting_id`
2. If status is `delivered` or `total_attempts >= max_attempts (30)` → skip
3. Calls `send_report(meeting_id, db)`:
   - Loads SMTP config from DB via `smtp_config_service.get_smtp_config(db)`
   - If unconfigured → raises `SmtpNotConfiguredError` → `status = failed`, no retry
   - Renders `report_email.html` Jinja2 template with full meeting detail
   - Sends via `aiosmtplib`
4. On success: `status = 'delivered'`
5. On SMTP failure: increment `total_attempts`; set `next_retry_at` with exponential backoff; `status = 'pending'`

On Lambda cold start, `requeue_pending_on_startup()` reschedules any pending email deliveries not yet delivered.

---

## Key Behaviours

- **SMTP password is write-only**: `GET /api/admin/config/smtp` never returns the password. `PUT` with `smtp_password = None` preserves the existing encrypted value.
- **Encryption**: AES-256-GCM with `SMTP_ENCRYPTION_KEY` env var. The key must be set in all environments.
- **Resend resets retry counter**: `POST /api/admin/general-meetings/{id}/resend-report` resets `total_attempts = 0`, giving a fresh 30-attempt budget.
- **Non-retryable auth errors**: SMTP auth failures set `status = failed` immediately (no exponential retry since retrying with wrong credentials would just fail again).
- **EMAIL_OVERRIDE**: When `settings.email_override` is set (non-empty), all outgoing emails are redirected to that address. The original recipient is preserved in the `X-Original-To` header. Used in test/preview environments to prevent real emails to lot owners.
- **Multi-choice voter lists in email**: `report_email.html` iterates `motion.voter_lists.options_for/against/abstained` for multi-choice motions to show per-option breakdown.

---

## Security Considerations

- `smtp_password_enc` is never returned in any API response
- `SMTP_ENCRYPTION_KEY` must be set in production; startup logs WARNING if absent
- `POST /api/admin/config/smtp/test` rate-limited to prevent relay abuse
- Email content scope: sent only to `Building.manager_email` (admin-level recipient)

---

## Files

| File | Role |
|---|---|
| `backend/app/models/tenant_smtp_config.py` | `TenantSmtpConfig` singleton model |
| `backend/app/models/email_delivery.py` | `EmailDelivery` model |
| `backend/app/crypto.py` | AES-256-GCM encrypt/decrypt |
| `backend/app/services/smtp_config_service.py` | `get_smtp_config`, `update_smtp_config`, `is_smtp_configured` |
| `backend/app/services/email_service.py` | `send_report`, `send_otp_email`, `trigger_with_retry`; `SmtpNotConfiguredError` |
| `backend/app/schemas/config.py` | `SmtpConfigOut`, `SmtpConfigUpdate`, `SmtpStatusOut` |
| `backend/app/routers/admin.py` | SMTP config endpoints; `resend-report` endpoint |
| `backend/app/templates/report_email.html` | Meeting summary email template |
| `backend/app/templates/otp_email.html` | OTP email template |
| `backend/app/config.py` | `smtp_encryption_key`; deprecated `smtp_*` env var fields |
| `frontend/src/api/config.ts` | `getSmtpConfig`, `updateSmtpConfig`, `testSmtpConfig`, `getSmtpStatus` |
| `frontend/src/pages/admin/SettingsPage.tsx` | Mail Server section |
| `frontend/src/pages/admin/AdminLayout.tsx` | SMTP unconfigured banner |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Resend Summary Email button |

---

## Schema Migration Required

Yes — `tenant_smtp_config` table (with data migration seeding from env vars if present).
