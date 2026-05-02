# PRD: Platform — Branding, SMTP, Email Delivery, and Session Security

## Introduction

This document covers cross-cutting platform concerns: tenant branding configuration (logo, favicon, colours, app name), SMTP mail server settings via the admin UI, email delivery (meeting close report, OTP emails), and session security.

---

## Goals

- Allow a meeting host to configure the app name, logo, primary colour, and support email for their deployment
- Apply branding app-wide via React context without a page reload
- Allow admins to configure SMTP mail server settings in the admin UI rather than relying on environment variables, with encrypted storage and a test-send capability
- Ensure email delivery (OTP emails and results reports) reads SMTP settings from the DB at send time
- Provide a persistent warning banner when SMTP is unconfigured so admins notice the gap before a meeting close fails silently

---

## User Stories

### US-CFG-01: Admin can view and edit tenant branding settings

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to configure the app name, logo, primary colour, and support email for my deployment so that the voting app reflects my organisation's identity.

**Acceptance Criteria:**

- [ ] A "Settings" nav item appears in the admin sidebar and navigates to `/admin/settings`
- [ ] The Settings page loads the current config via `GET /api/admin/config` and displays all four fields: App name, Logo URL, Primary colour, Support email
- [ ] Admin can edit any combination of the four fields and save via `PUT /api/admin/config`
- [ ] The form shows "Saving…" on the button while the request is in flight
- [ ] On success, an inline success message "Settings saved" is shown
- [ ] Server-side validation errors are shown inline below the relevant field
- [ ] App name is required; submitting with an empty app name returns 422
- [ ] Primary colour must be a valid 3- or 6-digit CSS hex string (e.g. `#1a73e8`, `#fff`); submitting an invalid value returns 422
- [ ] Logo URL and support email are optional; clearing them saves empty strings (treated as "not set")
- [ ] After a successful save, the admin sidebar branding (app name, logo, primary colour) updates immediately without a page reload
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-CFG-02: Branding config applied app-wide via React context

**Status:** ✅ Implemented

**Description:** As a voter, I want the app to display the configured app name, logo, and primary colour so that the voting experience matches the host organisation's branding.

**Acceptance Criteria:**

- [ ] On app load, the frontend fetches `GET /api/config` (public, no auth) and stores the result in a `BrandingContext`
- [ ] While the config is loading, the app renders without branding changes (falls back to compile-time defaults)
- [ ] The browser tab title (`<title>`) is set to the configured app name
- [ ] The voter shell header displays the configured logo (as an `<img>`) if `logo_url` is non-empty; if empty, the app name is shown as text instead
- [ ] The admin sidebar header uses the same logo/app name logic as the voter shell
- [ ] The primary colour CSS custom property (`--color-primary`) is updated in the document root when config loads, applying the colour app-wide
- [ ] The support email, if non-empty, is shown on the voter auth page and confirmation page as a "Need help? Contact [email]" link
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-CFG-03: Deployment seeded with default branding on first migration

**Status:** ✅ Implemented

**Description:** As a developer or operator deploying a new instance, I want the system to start with sensible defaults so the app is usable immediately without any manual configuration step.

**Acceptance Criteria:**

- [ ] The Alembic migration that creates `tenant_config` also inserts a single seed row with: `app_name = "AGM Voting"`, `logo_url = ""`, `primary_colour = "#005f73"`, `support_email = ""`
- [ ] The seed row is only inserted if the table is empty (idempotent — re-running the migration does not duplicate the row)
- [ ] `GET /api/config` returns the seed values on a fresh deployment before any admin has edited settings
- [ ] All tests pass at 100% coverage

---

### US-AUIF-10: Logo and favicon fall back to OCSS branding when unconfigured

**Status:** ✅ Implemented

**Description:** As a platform operator, I want the voter portal and admin portal to display the OCSS logo and favicon when no tenant branding has been configured.

**Acceptance Criteria:**

- [ ] When `logo_url` is empty or not set in admin settings, the voter portal header and admin sidebar display the OCSS fallback logo (`https://sentw3x37yabsacv.public.blob.vercel-storage.com/ocss-logo-C9E81q9ZrYhx9aARiYOvaF3gn1cqp1.svg`)
- [ ] When `favicon_url` is empty or not set, the browser tab favicon uses the OCSS fallback favicon (`https://sentw3x37yabsacv.public.blob.vercel-storage.com/ocss-favicon-4CMVReCEFGq06d9bG9Q8NqTrZqRosj.svg`)
- [ ] When tenant branding is configured with a custom logo or favicon, the custom values continue to take priority
- [ ] The fallback logic is centralised in `BrandingContext` — no per-component fallback code
- [ ] Typecheck/lint passes

---

### US-SMTP-01: Admin configures SMTP host, port, username, and from-address in UI

**Status:** ✅ Implemented

**Description:** As an admin, I want to enter SMTP server settings in the admin settings page so that I can configure outgoing email without needing access to environment variables.

**Acceptance Criteria:**

- [ ] The admin Settings page gains a new "Mail Server" section (card) below the existing Tenant Branding card
- [ ] The section contains fields: **Host** (text, required), **Port** (number, required, default 587), **Username** (text, required), **From email address** (email, required)
- [ ] All four fields are pre-populated from the current DB configuration on page load
- [ ] Saving the form calls `PUT /api/admin/config/smtp` with the four values; success shows an inline "Saved" confirmation
- [ ] Validation: host must be non-empty; port must be an integer 1–65535; username must be non-empty; from-email must be a valid email address
- [ ] If the DB has no SMTP configuration yet, all fields render empty and a dismissible banner reads: "Mail server is not configured — emails will not be sent until SMTP settings are saved."
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-SMTP-02: Admin sets SMTP password in UI (encrypted at rest)

**Status:** ✅ Implemented

**Description:** As an admin, I want to enter (or update) the SMTP password in the UI so that the full credential set can be managed without environment variable access, with confidence that the password is stored securely.

**Acceptance Criteria:**

- [ ] The Mail Server section includes a **Password** field (type="password") with placeholder "Enter new password to change"
- [ ] The field is always blank on load — the stored password is never sent to the client
- [ ] If the password field is left blank on save, the existing stored password is retained unchanged
- [ ] If a non-empty value is entered, it is encrypted server-side using AES-256-GCM with the key from the `SMTP_ENCRYPTION_KEY` env var before being stored in the DB
- [ ] `SMTP_ENCRYPTION_KEY` must be present in production/preview environments; if absent, the app logs a startup warning and the password field is disabled in the UI
- [ ] The password is decrypted in memory when constructing the SMTP connection; it is never returned in any API response
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-SMTP-03: Send test email from admin settings

**Status:** ✅ Implemented

**Description:** As an admin, I want to send a test email from the Settings page so that I can verify the SMTP configuration is correct before the next meeting close.

**Acceptance Criteria:**

- [ ] The Mail Server section contains a **Send test email** button
- [ ] Clicking it calls `POST /api/admin/config/smtp/test`; the endpoint sends a plain text "Test email from AGM Voting App" message to the `smtp_from_email` address using the currently saved DB SMTP settings
- [ ] While the request is in-flight the button shows "Sending…" and is disabled
- [ ] On success an inline green message reads: "Test email sent to [from_email]"
- [ ] On failure an inline red message shows the SMTP error detail (e.g., "Authentication failed", "Connection refused to mail.example.com:587")
- [ ] The test endpoint requires admin authentication and is rate-limited to 5 calls per minute per admin session
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-SMTP-04: Email service reads SMTP config from DB at send time

**Status:** ✅ Implemented

**Description:** As a platform operator, I want all outgoing emails to use the SMTP settings stored in the DB rather than environment variables, so that SMTP changes take effect immediately without a redeployment.

**Acceptance Criteria:**

- [ ] `email_service.send_report()` fetches SMTP settings from `tenant_smtp_config` DB table at the start of each send attempt
- [ ] `email_service.send_otp_email()` similarly fetches from DB at send time
- [ ] If the DB has no SMTP row, or any required field (host, port, username, from_email) is empty, both functions raise `SmtpNotConfiguredError` before attempting any connection
- [ ] There is no env-var fallback — env vars (`SMTP_HOST` etc.) are removed from `Settings` once DB-backed config is fully deployed
- [ ] The `EmailDelivery` record captures `last_error = "SMTP not configured"` when `SmtpNotConfiguredError` is raised, with `status = failed` (no retry) so the admin error banner appears immediately
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-SMTP-05: Unconfigured SMTP banner visible on all admin pages

**Status:** ✅ Implemented

**Description:** As an admin, I want a persistent warning banner when SMTP is unconfigured so that I notice the gap before a meeting close fails silently.

**Acceptance Criteria:**

- [ ] `GET /api/admin/config/smtp/status` returns `{"configured": true|false}`; `configured` is `true` only when all required fields (host, port, username, password, from_email) have non-empty values in the DB
- [ ] The admin layout shell fetches this status on mount and on each navigation
- [ ] When `configured = false`, a dismissible amber banner is shown at the top of every admin page: "Mail server not configured — meeting results emails will not be sent. [Configure now →]" (link to Settings page Mail Server section)
- [ ] The banner is suppressed once SMTP is configured
- [ ] The banner is only visible to authenticated admins, not on public or voter-facing pages
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-SMTP-06: SMTP settings preserved across deployments via DB migration

**Status:** ✅ Implemented

**Description:** As a platform operator, I want the SMTP configuration migration to seed the DB from the existing env vars on first deploy so that email delivery is not interrupted when switching from env-var to DB-backed config.

**Acceptance Criteria:**

- [ ] The Alembic migration that creates the `tenant_smtp_config` table includes a data migration step: if `SMTP_HOST` env var is non-empty, it seeds the new table with the existing env var values (host, port, username, from_email); password is seeded as an AES-256-GCM encrypted value of `SMTP_PASSWORD` if `SMTP_ENCRYPTION_KEY` is also set; otherwise password is stored as empty
- [ ] After migration, emails continue to work without any admin action if the env vars were previously set
- [ ] The migration is idempotent — running it twice does not overwrite a row the admin has already edited
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-006: Sync lot owner data from PropertyIQ

**Status:** 🔄 Partial — PropertyIQ API credentials pending

**Description:** As a meeting host, I want to sync lot owner data from PropertyIQ so I don't have to manually export/import CSVs.

**Acceptance Criteria:**

- [ ] Host can trigger a manual sync for a building from the admin portal
- [ ] System fetches lot owner records from the PropertyIQ API for the relevant building
- [ ] Sync result shows count of records added/updated/removed
- [ ] Synced data affects authentication for future logins but does not alter the weight snapshot of any already-open meeting
- [ ] If sync fails, an error message is shown and existing data is not modified
- [ ] Typecheck/lint passes

---

## Technical Considerations

- **Email retry:** Up to 30 retries with exponential backoff; all retry attempts (attempt number, delay, error, timestamp) logged as OTEL-compliant structured log events; delivery status persisted in the database; retry state survives server restarts (stored in DB, re-queued on startup if status is `pending`).
- **SMTP password encryption:** AES-256-GCM encryption/decryption happens entirely in the Python service layer using the `SMTP_ENCRYPTION_KEY` env var (32-byte random key, base64-encoded).
- **Session management:** Server-side sessions stored in the database (not in-memory) to survive server restarts. Session cookies must be HttpOnly, Secure, and SameSite=Strict.
- **CORS:** Restricted to the frontend origin only; all other origins rejected; configured via environment variable (`ALLOWED_ORIGIN`).
- **Server time API:** A `GET /api/server-time` endpoint returns the current UTC timestamp; used by the frontend to anchor the countdown timer.
- **Environment variables:** `DATABASE_URL`, `VITE_API_BASE_URL`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SMTP_ENCRYPTION_KEY`, `ALLOWED_ORIGIN`. SMTP settings (host, port, username, password, from_email) are now configured via the admin Settings page and stored encrypted in the database — no longer needed as env vars.
- **PropertyIQ integration:** PropertyIQ API — API credentials and endpoint details needed before US-006 can be built.
- **Deployment:** Lambda deployment via Vercel. DB migrations run as a Vercel pre-deploy build step (`buildCommand` in `vercel.json`), not on Lambda cold start.

---

---

### US-USR-01: Admin lists all admin users

**Status:** ✅ Implemented — branch: `admin-user-management`, committed 2026-05-01

**Description:** As an admin, I want to see all current admin users so I can understand who has access to the admin panel.

**Acceptance Criteria:**

- [ ] A "Users" nav item appears in the admin sidebar and navigates to `/admin/users`
- [ ] The Users page loads the current user list via `GET /api/admin/users` and renders a flat table with columns: Email and Created date
- [ ] Created date is formatted as a human-readable local date (e.g. "1 May 2026")
- [ ] The current logged-in admin's own row is visually marked (e.g. "(you)" suffix on the email)
- [ ] The table handles loading, error, and empty states
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-USR-02: Admin invites a new admin user

**Status:** ✅ Implemented — branch: `admin-user-management`, committed 2026-05-01

**Description:** As an admin, I want to invite a new admin user by email so they can set up their own password and access the admin panel.

**Acceptance Criteria:**

- [ ] The Users page has an "Invite admin" button that opens an inline form with a single email field
- [ ] Submitting the form calls `POST /api/admin/users/invite` with `{"email": "..."}` and shows a loading state while in flight
- [ ] The backend creates the user in Neon Auth via the management API and immediately triggers a password-reset email to the invited address
- [ ] On success, an inline confirmation message reads: "Invite sent to [email]" and the new user appears in the table
- [ ] If the email is already registered as an admin user, the endpoint returns 409 and the form shows: "A user with that email already exists."
- [ ] If the email is invalid (not a valid email format), the endpoint returns 422 and the form shows the validation error
- [ ] No plain-text password is ever stored or shown to the inviting admin
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

**Implementation notes (security and reliability — branch: `fix/review-backend`):**

- Rate limit is now keyed on `current_user.user_id` (not the string "admin") so each admin's invite quota is tracked independently (SRE-1).
- A success audit log (`admin_user_invited`) is emitted after each successful invite with `performed_by` and `target_email` fields (BACKEND-1/LEGAL-1).
- If the password-reset email call fails after the Neon Auth user is created, the orphaned account is automatically deleted before raising the error to prevent invite re-attempts from hitting a 409 (SECURITY-4).
- All Neon management API calls retry once on HTTP 5xx with a 1-second delay (SRE-2).

---

### US-USR-03: Admin removes an admin user

**Status:** ✅ Implemented — branch: `admin-user-management`, committed 2026-05-01

**Description:** As an admin, I want to remove another admin user so they can no longer access the admin panel.

**Acceptance Criteria:**

- [ ] Each user row has a "Remove" button (`.btn--danger` style) — except for the current logged-in admin's own row, where no Remove button is shown at all
- [ ] Clicking "Remove" shows a confirmation dialog: "Remove [email]? They will lose admin access immediately."
- [ ] Confirming calls `DELETE /api/admin/users/{user_id}` and shows a loading state while in flight
- [ ] On success, the removed user disappears from the table; an inline confirmation reads: "User removed."
- [ ] If the user being removed is the last admin, the endpoint returns 409 and the UI shows an inline error: "Cannot remove the last admin user."
- [ ] If the user does not exist, the endpoint returns 404
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

**Implementation notes (security and reliability — branch: `fix/review-backend`):**

- A success audit log (`admin_user_removed`) is emitted after each successful removal with `performed_by` and `target_user_id` fields (BACKEND-1/LEGAL-1).
- After the delete completes, the endpoint re-queries the user list and logs a `CRITICAL` event if zero admins remain. This narrows the TOCTOU gap in the last-admin guard (SECURITY-3). A true atomic fix requires Neon Auth to enforce this constraint server-side.
- All Neon management API calls retry once on HTTP 5xx with a 1-second delay (SRE-2).

---

## Non-Goals

- No per-building SMTP configuration (one global config per tenant)
- No SMTP OAuth / app-password flows (STARTTLS username+password only)
- No exporting or viewing the SMTP password from the admin UI (write-only field)
- No email notifications to lot owners (invites, reminders, vote confirmations)
- No PropertyIQ sync changes until API credentials are provided
- No role hierarchy for admin users (flat — any admin can invite or remove others)
- No self-removal (the current admin's Remove button is hidden, not merely disabled)
