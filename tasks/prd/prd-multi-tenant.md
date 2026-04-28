# PRD: Multi-Tenant Platform

## Introduction

The AGM Voting App operates as a single-tenant system: one global admin credential controls all buildings, lot owners, and meetings. This PRD describes the path to a multi-tenant product where each customer (a strata management company) runs on their own isolated deployment — their own Vercel project and their own Neon database project. Data isolation is guaranteed at the infrastructure level rather than within the application. A provisioning CLI script (`scripts/provision_customer.py`) handles customer onboarding. The voter-facing URLs and authentication flows are unchanged.

---

## Architecture Decision: Deployment-per-Tenant

**Decision date:** 2026-04-26

**The schema-per-tenant approach originally described in this PRD has been replaced by a deployment-per-tenant model.**

### Original approach (abandoned)

The original design proposed schema isolation within a single Vercel project and a single Neon project: each tenant would get a `tenant_{slug}` PostgreSQL schema, an in-app router would resolve the correct schema on every request, and a platform operator superadmin would manage all tenants through a `/platform/admin` UI.

### Revised approach: deployment-per-tenant

Each customer gets:
- Their own Vercel project (separate deployment, separate env vars, separate Lambda runtime)
- Their own Neon project (separate PostgreSQL cluster, no shared connection pool)

The app code is identical across all deployments. There is no in-app tenant routing, no schema switching, no `public.organisations` table, and no platform operator UI. Data isolation is absolute — a bug in one deployment cannot touch another tenant's database.

### Why this was chosen

1. **Vercel and Neon economics**: Neon's free and launch plans provision per-project, not per-schema. Each Vercel project gets its own preview URL and env var namespace. The per-deployment model fits the product as a standard single-tenant app deployed N times — no bespoke multi-tenancy infrastructure required.

2. **Zero in-app complexity**: No schema-routing middleware, no `search_path` management, no per-request tenant resolution. The app remains a straightforward single-tenant FastAPI + React app. This eliminates an entire category of security risk (cross-tenant data leakage via missing schema guards).

3. **Independent deployment cadence**: Each customer's deployment can be upgraded, rolled back, or migrated independently. A failed migration for one customer does not affect any other.

4. **Operational simplicity at current scale**: The platform operator runs a CLI script once per new customer. No UI, no API, no real-time provisioning infrastructure to maintain.

### Consequences for this PRD

- MT-PO-01 through MT-PO-08 (platform operator API + UI) are out of scope — replaced by the provisioning CLI script.
- MT-DI-01 through MT-DI-04 (in-app schema isolation) are out of scope — isolation is handled by infrastructure.
- MT-VT-01 and MT-VT-02 (voter route tenant resolution) are out of scope — each deployment already resolves only its own data.
- MT-TA-01 through MT-TA-04 (admin auth) remain in scope, implemented via Neon Auth (Better Auth) rather than custom session-cookie code.

---

## Goals

- Allow multiple independent organisations to use the platform with zero data leakage between them (guaranteed by infrastructure separation)
- Replace the single global `ADMIN_PASSWORD` / `ADMIN_USERNAME` env var pair with per-deployment user accounts (email + password) managed by Neon Auth
- Give each deployment its own admin user management (invite, remove, change role) via the Neon Auth Organization plugin
- Provide a one-command provisioning script for onboarding new customers
- Preserve the existing voter experience entirely — no URL or flow changes for lot owners

---

## User Stories

### MT-TA-01: Sign up / be invited to an organisation

**Status:** In scope — implemented via Neon Auth (Better Auth) Organization plugin.

**Key change from original design:** Admin users are identified by email address rather than a plain username string. The Neon Auth Organization plugin provides invite-based signup out of the box — the platform operator (or the first admin) invites a new user by email; an invitation email is sent and the user sets a password on acceptance.

**Description:** As a new tenant admin, I want to be invited to the admin portal by email so that I can gain access without needing a shared password.

**Acceptance Criteria:**

- [ ] Neon Auth's invite-to-organisation flow sends an invitation email to the provided address with a single-use accept link valid for 48 hours
- [ ] The invited user sets their password via the accept link
- [ ] Accepting an expired or already-used token shows an error
- [ ] Inviting an email already in the organisation returns a conflict error
- [ ] Initial admin account is created during provisioning (see `scripts/provision_customer.py`)
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### MT-TA-02: Log in with email + password

**Status:** In scope — implemented via Neon Auth (Better Auth) email + password sign-in.

**Key change from original design:** The `POST /api/admin/auth/login` endpoint that validates `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars is removed. The `AdminLoginPage` frontend component swaps to the Better Auth client SDK sign-in. IP-based rate limiting (`admin_login_attempt` table and middleware) is retained as a custom layer on top of Better Auth, since Better Auth does not provide IP-based rate limiting.

**Description:** As a tenant admin, I want to log in with my email and password so that I have a personal, auditable session.

**Acceptance Criteria:**

- [ ] Admin users log in via the Better Auth sign-in flow (email + password)
- [ ] Invalid credentials return a 401-equivalent error; the response does not indicate whether email or password was wrong
- [ ] Rate limiting: 5 failed attempts within 15 minutes from the same IP returns 429 until the window expires (enforced by custom `AdminLoginAttempt` middleware, not Better Auth)
- [ ] Session encodes the Better Auth JWT identifying the user and their organisation
- [ ] The old `POST /api/admin/auth/login` endpoint (global ADMIN_PASSWORD) is removed
- [ ] `ADMIN_USERNAME` and `ADMIN_PASSWORD` env vars are removed from required configuration
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### MT-TA-03: Manage org admin users

**Status:** In scope — implemented via Neon Auth (Better Auth) Organization plugin.

**Key change from original design:** User management (list, invite, remove, change role) is handled by the Neon Auth Organization plugin rather than custom `organisation_users` table CRUD endpoints. Roles are: `owner`, `admin`, `member` (as defined by the Better Auth Organization plugin).

**Description:** As an organisation owner, I want to invite, remove, and change the role of admin users in my organisation.

**Acceptance Criteria:**

- [ ] Organisation owner can invite a new admin user by email via Neon Auth
- [ ] Organisation owner can remove a user from the organisation
- [ ] An owner cannot remove themselves
- [ ] An organisation must retain at least one owner
- [ ] Organisation owner can change a user's role
- [ ] All actions require an authenticated owner session
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### MT-TA-04: View org settings

**Status:** In scope — implemented via Neon Auth (Better Auth) Organization plugin session context.

**Key change from original design:** Organisation name and settings are read from the Neon Auth session/organisation context rather than a custom `GET /api/org/{slug}/admin/settings` endpoint.

**Description:** As a tenant admin, I want to view my organisation's name and settings so that I can confirm I am in the correct context.

**Acceptance Criteria:**

- [ ] Authenticated admin can read their organisation name from the Neon Auth session context
- [ ] Requires a valid Better Auth session; unauthenticated requests are rejected
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### MT-TA-05: Access admin dashboard scoped to their organisation only

**Status:** In scope — trivially satisfied by deployment-per-tenant. Each deployment's database contains only that organisation's data. No cross-org routing is possible.

**Description:** As a tenant admin, I want the admin dashboard to show only my organisation's data.

**Acceptance Criteria:**

- [ ] The deployment's database contains only the data for this customer — no routing logic required
- [ ] All existing admin features (building management, AGM creation, etc.) work as before, authenticated via Neon Auth session
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### MT-TA-06: All existing admin features work within org scope

**Status:** In scope — existing features require no URL changes; they are re-authenticated via Neon Auth rather than the legacy session-cookie check.

**Description:** As a tenant admin, I want all existing admin features to work exactly as before.

**Acceptance Criteria:**

- [ ] Building CRUD, lot owner import, AGM creation/close, motion management, report viewing, ballot reset all function under the existing `/api/admin/` prefix
- [ ] Feature behaviour and API contracts are identical to the pre-multi-tenant implementation
- [ ] `require_admin` dependency validates a Better Auth JWT rather than a session cookie
- [ ] All existing admin E2E tests pass after the auth layer swap
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

## Provisioning Script

**Path:** `scripts/provision_customer.py`

**When to run:** Once per new customer, by the platform operator.

**What it does:**

1. Creates a new Neon project for the customer via the Neon API
2. Creates a Vercel project (or configures an existing one) and sets the required env vars (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `SESSION_SECRET`, `SMTP_ENCRYPTION_KEY`, `ALLOWED_ORIGIN`)
3. Runs `alembic upgrade head` against the new Neon project to apply all schema migrations
4. Provisions Neon Auth on the new Neon project and configures the Organization plugin
5. Creates the initial admin user in Neon Auth (or sends an invite email to the provided admin email)
6. Optionally configures a custom domain on the Vercel project

**Inputs:**
- `--name` — customer display name (e.g. "Acme Strata")
- `--slug` — URL-safe identifier (e.g. `acme-strata`); used as the Neon project name and Vercel project name
- `--admin-email` — email address for the initial admin user
- `--plan` — one of `free`, `standard`, `enterprise` (informational; controls Neon plan selection)
- `--domain` — optional custom domain to configure on the Vercel project

**Required env vars for the script:**
- `NEON_API_KEY`
- `VERCEL_API_TOKEN`

**Idempotency:** Re-running the script for an existing slug is a no-op — each step checks whether the resource already exists before attempting to create it.

**Full technical design:** See `tasks/design/design-multi-tenant.md`.

---

## Non-Goals

- In-app platform operator UI — provisioning is CLI-only
- Shared-database multi-tenancy — each deployment has its own database
- Schema-per-tenant routing — not needed in deployment-per-tenant model
- Billing integration — `plan` field is informational only
- Self-service tenant sign-up — onboarding is operator-initiated via the CLI script
- Changes to the voter-facing UI or UX — voter flows are explicitly out of scope
- SSO / OAuth / SAML — authentication uses email + password only in this version

---

## Technical Considerations

- The deployment-per-tenant model means the app code is standard single-tenant FastAPI + React; no schema-switching, no `search_path` manipulation, no tenant-resolution middleware
- Neon Auth (Better Auth) is currently in Beta, as is the Organization plugin — see `tasks/design/design-multi-tenant.md` for risk mitigation
- The `admin_username` audit field on `BallotSubmission` must continue to be populated; in the new auth model, populate it from the Better Auth session `user.email`
- IP-based rate limiting (`admin_login_attempt` table) is retained as a custom middleware layer; Better Auth does not provide IP-based rate limiting
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` env vars are removed from required configuration after this change; `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` replace them
- Alembic continues to run in the Vercel `buildCommand` on every push — no change to the migration strategy

---

## Success Metrics

- A new customer deployment can be provisioned end-to-end via `scripts/provision_customer.py` in under 5 minutes
- Zero cross-tenant data leakage is possible by design (infrastructure isolation)
- All existing admin and voter E2E tests pass after the Neon Auth swap
- Admin login with email + password works on the first attempt after provisioning

---

## Open Questions

- Should the `viewer` role be supported at launch, or should only `owner` and `admin` be implemented initially?
- What is the desired first-login flow — does the platform operator set a temporary password during provisioning, or does the invited owner set their password via the invite flow?
- Should the provisioning script support bulk provisioning (multiple customers from a CSV), or is one-at-a-time sufficient?
