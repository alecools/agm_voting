# PRD: AGM Voting App — Master Overview

## Introduction

A web application for body corporates to run voting during Annual General Meetings (AGMs). The host creates a General Meeting with a list of motions and a scheduled voting close time. At meeting creation, unit entitlement weights are snapshotted for every lot in the building; any subsequent changes to lot owner data do not affect that meeting's tallies. Lot owners authenticate via a one-time email code, cast votes on each motion, and submit their ballot (votes are final once submitted). When the manager closes voting, the system emails a summary report to the manager's email address stored against the building.

**Stack:** React (Vite) · FastAPI · PostgreSQL · SQLAlchemy + Alembic · Brevo SMTP (email)

---

## Goals

- Allow a meeting host to create a General Meeting with motions, a meeting date/time, and a scheduled voting close time via a dedicated admin portal; snapshot lot entitlement weights at creation
- Allow lot owners to self-authenticate using email OTP (no account creation required); one ballot per lot per meeting
- Allow lot owners to vote yes/no/abstain (or select options on multi-choice motions); votes are held in client-side state and are final once submitted
- Show lot owners a countdown timer (anchored to server time) to scheduled close; allow lot owners to review past submissions
- Allow the manager to close voting and trigger an automated result report sent to the building's manager email, with up to 30 retries and structured logging
- Support lot owner data ingestion via CSV/Excel upload and manual UI entry
- Support building creation and updates via CSV/Excel upload; building names are globally unique
- Weight each ballot by the snapshotted sum of unit entitlements for all lots owned by the voter's email, taken at meeting creation time

---

## Personas

| Persona | Flow |
|---|---|
| **Voter** | Auth (OTP) → lot selection → voting → confirmation |
| **Proxy voter** | Auth (OTP) → proxied lots → voting → confirmation |
| **In-arrear lot** | Auth (OTP) → lot with in-arrear badge → `not_eligible` on General Motions → confirmation |
| **Admin** | Login → building/meeting management → report viewing → close meeting |

---

## Non-Goals

- No PropertyIQ sync (pending API credentials)
- No real-time WebSocket updates (polling is sufficient)
- No live vote dashboard for the manager during the meeting
- No email notifications to lot owners (invites, reminders, vote confirmations)
- No mobile app (web responsive is acceptable)
- No automatic AGM close at `voting_closes_at` — the timer is informational; the manager always closes manually
- No server-side pagination for admin list views (client-side pagination with full-list fetch)

---

## Non-Functional Requirements

### NFR-PERF-01: Frontend bundle optimisation

The voter-facing JavaScript bundle must not include the `xlsx` library. `xlsx` is used only by the admin motion upload flow and must be loaded lazily (dynamic import) so it is never downloaded by lot owners.

### NFR-PERF-02: Static asset CDN serving

All Vite-built assets under `/assets/` must be served from Vercel's CDN edge, not the FastAPI Lambda. `vercel.json` sets `outputDirectory: "frontend/dist"` and all `/assets/` paths are served with `Cache-Control: public, max-age=31536000, immutable`.

### NFR-PERF-03: Logo optimisation

`frontend/public/logo.png` must be supplemented with a WebP version. All logo `<img>` references must be wrapped in a `<picture>` element targeting ~60–75% size reduction for WebP-capable browsers.

### NFR-PERF-04: Brotli pre-compression

The Vite build must pre-generate `.br` files for all JS/CSS assets using `vite-plugin-compression`.

---

## Success Metrics

- A complete meeting can be run end-to-end (create → authenticate → vote → close → report) without errors
- Lot owner authentication takes under 30 seconds from opening the link
- Results report email is received within 1 minute of closing the meeting under normal conditions
- All email retry attempts are visible in structured logs with full context

---

## Table of Contents — Feature-Area PRDs

| File | Contents |
|---|---|
| `prd-buildings-and-lots.md` | Building management, lot owner management, CSV/Excel import, financial positions (in-arrear), proxy nominations, owner names |
| `prd-meetings.md` | Meeting lifecycle (create/pending/open/close/delete), per-motion voting windows, meeting status transitions |
| `prd-motions.md` | Motion CRUD, ordering, visibility toggles, motion types, multi-choice motions, Excel import, motion numbers |
| `prd-voting-flow.md` | Voter authentication (OTP), lot selection, ballot submission, confirmation, proxy voting UX, multi-lot voting, re-voting, eligibility rules |
| `prd-admin-panel.md` | Admin login, admin in-person vote entry, admin meeting detail/results, pagination/navigation, QR share link, co-owner ballot visibility |
| `prd-platform.md` | Tenant branding, SMTP configuration, email delivery, session security |

---

## Open Questions

1. What are the PropertyIQ API credentials and endpoint details needed for the sync integration (US-006)? — **blocked, will revisit later**
2. Should the admin portal be protected by any access mechanism before host authentication is formally scoped? (Currently unrestricted for MVP.)
3. ~~Should the AGM automatically close at `voting_closes_at`, or does the manager always close manually?~~ — **Resolved:** the timer is informational only; the manager always closes the AGM manually via the "Close Voting" button.
4. What is the verified sender email address and domain for Brevo SMTP? — **pending, to be provided by stakeholder**
