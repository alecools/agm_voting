# PRD: Admin Panel

## Introduction

This document covers admin portal authentication, the admin in-person vote entry flow, admin meeting detail and results views, navigation/pagination, the QR share link, and co-owner ballot visibility.

---

## Goals

- Protect all admin routes behind username/password authentication
- Allow admins to enter votes on behalf of lot owners who voted in person (paper or vocal)
- Show per-motion vote tallies with entitlement percentages, winning-option highlights, and For/Against/Abstain breakdown for multi-choice motions
- Provide a QR code for the voter share link directly on the admin meeting detail page
- Allow all lot co-owners to see the submitted ballot on the confirmation page
- Support collapsible Results Report section for a cleaner admin meeting detail view

---

## User Stories

### US-020: Admin portal authentication

**Status:** ✅ Implemented

**Description:** As a meeting host, I want the admin portal to require a username and password login so unauthorised users cannot access or modify meeting data.

**Acceptance Criteria:**

- [ ] All `/api/admin/*` endpoints (except login/logout/me) return 401 if the request is not authenticated
- [ ] `POST /api/admin/auth/login` accepts `username` and `password`; on success sets a signed session cookie and returns `{"ok": true}`; on failure returns 401
- [ ] `POST /api/admin/auth/logout` clears the session and returns `{"ok": true}`
- [ ] `GET /api/admin/auth/me` returns `{"authenticated": true}` if logged in, else 401
- [ ] Credentials are configured via `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables
- [ ] Admin portal frontend redirects unauthenticated users to `/admin/login`
- [ ] Login page shows username and password fields; on success navigates to `/admin`
- [ ] Admin layout sidebar shows a "Logout" button that calls logout endpoint and redirects to `/admin/login`
- [ ] Typecheck/lint passes

---

### US-MN-04: Admin login page uses tenant branding logo

**Status:** ✅ Implemented

**Description:** As a meeting host, I want the admin login page to display the configured tenant logo rather than a hardcoded static image.

**Acceptance Criteria:**

- [ ] The admin login page (`/admin/login`) reads the logo URL from `useBranding()` / `BrandingContext`
- [ ] When `logo_url` is a non-empty string, the login card displays the configured tenant logo
- [ ] When `logo_url` is empty string or not set, no broken image is displayed; the login card renders without an image
- [ ] The hardcoded `/logo.png` and `/logo.webp` references are removed from the login page
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-UI01: Back button on voter-facing pages

**Status:** ✅ Implemented

**Description:** As a voter, I want a back button on each step of the voting flow so I can correct mistakes without being stuck.

**Acceptance Criteria:**

- [ ] Voter verification page shows a back button that navigates to the building/meeting selection page
- [ ] Voting page shows a back button that navigates back to the auth page
- [ ] Back button is visually consistent with the existing design system (secondary/ghost style)
- [ ] Back button is not shown on the confirmation page (terminal step)
- [ ] Typecheck/lint passes

---

### US-UI02: Owner edit as centred modal

**Status:** ✅ Implemented

**Description:** As a building manager, I want the lot owner edit form to appear as a centred dialog so it doesn't displace the page layout.

**Acceptance Criteria:**

- [ ] Clicking "Edit" on a lot owner row opens a modal dialog centred on the viewport (both horizontally and vertically)
- [ ] The modal has a visible backdrop that dims the page behind it
- [ ] Clicking outside the modal or pressing Escape closes it without saving
- [ ] A "Cancel" button inside the modal also closes it without saving
- [ ] The modal is scrollable if content overflows the viewport height
- [ ] Typecheck/lint passes

---

### US-UI04: Entitlement percentage per motion option (admin report)

**Status:** ✅ Implemented

**Description:** As a building manager, I want to see what percentage of total building entitlement each vote option represents in the meeting report so I can assess the result at a glance.

**Acceptance Criteria:**

- [ ] In the admin meeting detail/report view, each tally row (For, Against, Abstained, Absent, Not eligible) shows the percentage of total building entitlement alongside the existing entitlement sum — e.g. "200 (14.3%)"
- [ ] Percentage is calculated as `entitlement_sum / total_building_entitlement * 100`, rounded to 1 decimal place
- [ ] If total building entitlement is 0, show "—" instead of a percentage
- [ ] The percentages are also visible in the live view while the meeting is still open
- [ ] Typecheck/lint passes

---

### US-016: Public meeting summary page

**Status:** ✅ Implemented

**Description:** As a lot owner or interested party, I want to view a public summary page for a General Meeting so I can review the motions before or during the meeting without logging in.

**Acceptance Criteria:**

- [ ] A new public route exists at `/agm/:agmId/summary`
- [ ] The page displays: meeting title, building name, meeting date/time (formatted in local timezone), and the ordered list of motions (motion number + title + description)
- [ ] The page requires no authentication — accessible by anyone with the URL
- [ ] If the meeting ID does not exist, the page shows a "Meeting not found" message
- [ ] The page has a print-friendly layout: when printed, navigation and action buttons are hidden
- [ ] The page title in the browser tab is `[Meeting title] — Meeting Summary`
- [ ] Typecheck/lint passes

---

### US-017: Share voting link from admin portal

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to easily copy the shareable voting link for a General Meeting so I can distribute it to lot owners.

**Acceptance Criteria:**

- [x] The General Meeting detail view in the admin portal shows a "Share voting link" button or link
- [x] Clicking it copies the full URL of the voter auth page (`/vote/:meetingId/auth`) to the clipboard
- [x] A brief confirmation message ("Link copied!") is shown after copying
- [x] The link is also displayed as a clickable URL so the host can open or inspect it
- [x] Typecheck/lint passes

---

### US-018: Backend endpoint for meeting public summary

**Status:** ✅ Implemented

**Description:** As a developer, I need a public API endpoint returning meeting summary data so the frontend summary page can fetch it without authentication.

**Acceptance Criteria:**

- [ ] `GET /api/agm/:agmId/summary` returns: `agm_id`, `title`, `status`, `meeting_at`, `voting_closes_at`, `building_name`, and an ordered array of motions (each with `motion_number`, `display_order`, `title`, `description`)
- [ ] The endpoint requires no authentication token
- [ ] Returns 404 if the meeting does not exist
- [ ] Returns data for both `open` and `closed` meetings
- [ ] Typecheck/lint passes

---

### US-AVE-01: Admin selects lots for in-person vote entry

**Status:** Done

**Description:** As an admin, I want to select which lot owner records I need to enter in-person votes for, so that I only see the relevant rows in the entry grid and avoid a cluttered view with all building lots.

**Acceptance Criteria:**

- [ ] The admin meeting detail page (open meeting only) has an "Enter In-Person Votes" button
- [ ] Clicking the button opens a lot-selection panel listing all lots in the building that have not yet submitted a ballot via the app
- [ ] Lots that have already submitted a ballot via the app are excluded from the selectable list and labelled "App submitted"
- [ ] Admin can check any number of pending lots from the list; the panel shows lot number and (if available) lot owner name(s)
- [ ] A "Proceed to vote entry" button is enabled only when at least one lot is checked; clicking it advances to the vote entry grid (US-AVE-02)
- [ ] A "Cancel" button dismisses the panel without saving any state
- [ ] All existing business rules and restrictions still apply (in-arrear lots, multi-choice option limits, motion visibility)
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AVE-02: Admin enters votes in grid UI

**Status:** Done

**Description:** As an admin, I want a dense grid showing motions as rows and selected lots as columns so I can quickly enter votes for multiple lots across all motions in one view.

**Acceptance Criteria:**

- [ ] The vote entry grid renders a table with one row per visible motion and one column per selected lot
- [ ] Each column header shows the lot number and (if available) the first owner's name
- [ ] Each cell contains a compact vote selector: For/Against/Abstain for binary motions; per-option For/Against/Abstain with `option_limit` enforced on "For" only for multi-choice motions
- [ ] In-arrear lots display a "Not eligible" indicator and disabled controls for `general` and `multi_choice` motion cells; `special` motion cells remain enabled for in-arrear lots
- [ ] A "Submit votes" button is shown at the bottom; admin must confirm a dialog before submission
- [ ] On confirmation, `POST /api/admin/general-meetings/{id}/enter-votes` is called with the selected lot IDs and their choices
- [ ] Motions with no selection for a given lot are recorded as `abstained` at submission time
- [ ] On success, the affected lots now appear as "App submitted" in the lot list
- [ ] On error, an inline error message is shown without dismissing the grid
- [ ] The entry UI is only available on open meetings
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AVE-03: Admin-submitted ballot is marked distinctly in results

**Status:** Done

**Description:** As an admin reviewing results, I want to see which ballots were entered by an admin on behalf of a voter, so I can distinguish in-person and app votes in the report.

**Acceptance Criteria:**

- [ ] `BallotSubmission` records created via admin vote entry have `submitted_by_admin = true`; app-submitted records have `submitted_by_admin = false` (default)
- [ ] The admin meeting results section shows an "Admin entered" indicator on rows where `submitted_by_admin = true`
- [ ] The CSV export includes a `Submitted By` column: `"Admin"` when `submitted_by_admin = true`, `"Voter"` otherwise
- [ ] The results report email shows a footnote for each motion listing how many votes were admin-entered
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AUIF-01: Admin vote entry respects multi-choice option limit

**Status:** ✅ Implemented

**Description:** As a meeting admin entering in-person votes, I want the For selection limit to be enforced in the vote entry grid.

**Acceptance Criteria:**

- [ ] In the admin in-person vote entry grid (step 2), for a multi-choice motion with `option_limit = N`, the "For" button for any option is disabled once N options have already been voted For for that lot
- [ ] A disabled "For" button shows an `aria-label` indicating the limit has been reached
- [ ] Clicking an already-selected "For" button deselects it and re-enables other "For" buttons
- [ ] "Against" and "Abstain" buttons are never disabled due to the For limit
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AUIF-02: Admin meeting view — collapsible results report section

**Status:** ✅ Implemented

**Description:** As a meeting admin, I want to collapse the Results Report section on the meeting detail page so I can focus on motions management without scrolling past a long report.

**Acceptance Criteria:**

- [ ] The Results Report section on the admin meeting detail page has a toggle button that collapses/expands the section
- [ ] The section is expanded by default
- [ ] The toggle button shows a clear visual indicator of collapsed vs expanded state (e.g. ▶/▼ chevron)
- [ ] The button has an `aria-expanded` attribute that reflects the current state
- [ ] Typecheck/lint passes

---

### US-AUIF-03: Admin results report — multi-choice counts visible without expanding

**Status:** ✅ Implemented

**Description:** As a meeting admin, I want to see the For/Against/Abstained voter counts for each multi-choice option at a glance (collapsed), and only expand to see individual voter details.

**Acceptance Criteria:**

- [ ] In the Results Report, each multi-choice option row shows For count, Against count, and Abstained count in the collapsed header
- [ ] Clicking the expand button ("Show voters") reveals the voter list (lot number, voter email, entitlement UOE) for that option
- [ ] The expand button toggles between "Show voters" and "Hide voters"
- [ ] The summary counts remain visible in the header when the voter list is expanded
- [ ] Typecheck/lint passes

---

### US-AUIF-04: Admin results report — highlight winning option(s) per motion

**Status:** ✅ Implemented

**Description:** As a meeting admin, I want the winning option to be visually highlighted in the Results Report so I can see outcomes at a glance.

**Acceptance Criteria:**

- [ ] For binary (non-multi-choice) motions: the "For" row is highlighted in green when For has higher weighted entitlement sum; the "Against" row is highlighted in red when Against has higher weighted entitlement sum; no highlight on a tie
- [ ] For multi-choice motions: the top N options by For weighted entitlement sum (where N = `motion.option_limit`) are highlighted in green
- [ ] Abstained, Absent, and Not eligible rows/options are never highlighted
- [ ] Highlighting uses the existing design system tokens (`var(--green-bg)`, `var(--green)`, etc.)
- [ ] Typecheck/lint passes

---

### US-MC-05: Admin views multi-choice motion results

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to see per-option vote tallies for multi-choice motions in the results report.

**Acceptance Criteria:**

- [ ] The admin meeting detail page results section shows a per-option breakdown for multi-choice motions
- [ ] Each option row shows: option text, voter count (number of lots that selected For), total UOE sum for For votes, and percentage of total building UOE
- [ ] Abstained (zero selections submitted) and Absent (never submitted) rows still appear below the option list
- [ ] Not-eligible rows appear for in-arrear lots
- [ ] `GET /api/admin/general-meetings/{id}` returns `tally.options: [{option_id, option_text, display_order, voter_count, entitlement_sum, for_voter_count, for_entitlement_sum, against_voter_count, against_entitlement_sum, abstained_voter_count, abstained_entitlement_sum, outcome}]` for multi-choice motions
- [ ] The CSV export includes one row per option per voter per category
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MC-RESULT-01: Multi-choice motion pass/fail outcome

**Status:** ✅ Implemented

**Description:** As a meeting host, I want the system to automatically determine which options pass and fail on a multi-choice motion so that I can announce the outcome without manually tallying weighted votes.

**Acceptance Criteria:**

- [ ] For each option on a closed multi-choice motion, the system computes `against_entitlement_sum` as a percentage of `total_building_entitlement`
- [ ] An option **fails** if its `against_entitlement_sum / total_building_entitlement > 0.50`
- [ ] Options that do not fail are ranked descending by their `for_entitlement_sum`; the top `option_limit` ranked options **pass**
- [ ] Ties at position `option_limit` / `option_limit + 1` result in `outcome = "tie"` with a "Tied position — admin review required" note
- [ ] Options: `outcome = "pass"` | `"fail"` | `"tie"`; non-multi-choice motions have `outcome = null`
- [ ] The admin meeting results section displays the outcome badge (Pass / Fail / Tie) beside each option row
- [ ] The results report email includes the outcome label per option
- [ ] `GET /api/admin/general-meetings/{id}` returns `tally.options[].outcome` for each option
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-MC-ADMIN-01: Admin meeting results show For/Against/Abstain tally per option

**Status:** ✅ Implemented

**Description:** As an admin reviewing meeting results, I want the results table for multi-choice motions to show separate For, Against, and Abstain counts and entitlement sums per option.

**Acceptance Criteria:**

- [ ] For each multi-choice motion option in the results view, the results table row expands to show three sub-rows (or columns): **For** (voter count + entitlement sum), **Against** (voter count + entitlement sum), **Abstained** (voter count + entitlement sum)
- [ ] The pass/fail outcome badge continues to appear beside the option name in the header row
- [ ] The For/Against/Abstain sub-rows are collapsed by default; a toggle button expands/collapses them per option
- [ ] When expanded, a voter list per category (For / Against / Abstained) is shown for that option
- [ ] The CSV export includes per-option For/Against/Abstain rows
- [ ] The emailed results report shows For/Against/Abstain counts per option
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-AVE2-01: Admin vote entry shows For/Against/Abstain buttons per multi-choice option

**Status:** ✅ Implemented

**Description:** As an admin entering in-person votes, I want each multi-choice option to have For / Against / Abstain buttons in the vote entry grid.

**Acceptance Criteria:**

- [ ] In the admin vote entry grid (Step 2), multi-choice motion cells render three compact toggle buttons per option: **For**, **Against**, **Abstain**
- [ ] The `option_limit` is enforced only on **For** selections — once the limit is reached all unselected "For" buttons for that lot × motion combination are disabled
- [ ] The counter reads: "X of Y voted For" (where Y = `option_limit`)
- [ ] Default/unset state for each option is blank (no button selected)
- [ ] On form submission, multi-choice votes are sent as `option_choices: [{option_id, choice}]` per option
- [ ] Legacy admin-entered ballots (submitted with the old checkbox UX, stored as `VoteChoice.selected`) display selected options as "For" when viewed read-only
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-EMAIL-01: Multi-choice voter listing in results report email

**Status:** ✅ Implemented

**Description:** As a meeting host, I want the results report email to list which lots voted for each option on multi-choice motions, so I can see per-option voter breakdowns.

**Acceptance Criteria:**

- [ ] For each option on a multi-choice motion, the email renders a voter list section (one row per lot: lot number, voter email, entitlement) identical in structure to the "Voted For" / "Voted Against" sections for binary motions
- [ ] Abstained and Absent voter list sections continue to appear for multi-choice motions
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-EMAIL-02: Motion resolution type in results report email

**Status:** ✅ Implemented

**Description:** As a meeting host, I want the results report email to label each motion as "General Resolution" or "Special Resolution".

**Acceptance Criteria:**

- [ ] Each motion header in the email shows "General Resolution" or "Special Resolution" beneath the motion number / title
- [ ] Multi-choice motions also show the resolution type label
- [ ] The label style is visually distinct from the motion title and does not break the existing email layout
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-EMAIL-03: Resend summary email button on admin meeting detail page

**Status:** ✅ Implemented

**Description:** As a meeting host, I want a "Resend Summary Email" button on the closed meeting detail page so I can re-trigger the results email at any time.

**Acceptance Criteria:**

- [ ] A "Resend Summary Email" button is visible on the admin meeting detail page when `meeting.status === "closed"`
- [ ] Clicking the button calls `POST /api/admin/general-meetings/{id}/resend-report` and shows a loading state while in flight
- [ ] On success the button shows a transient "Queued for resend" confirmation message
- [ ] On error the button shows an inline error message
- [ ] The backend `resend_report` service function allows resend regardless of the current `EmailDelivery.status`
- [ ] The endpoint still returns 404 if the meeting does not exist and 409 if the meeting is not closed
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-QR-01: QR code for voter share link on admin meeting detail page

**Status:** ✅ Implemented

**Description:** As a meeting host, I want to display a QR code for the voter-facing meeting URL on the admin meeting detail page so that I can project or print it for in-person attendees to scan.

**Acceptance Criteria:**

- [ ] The admin meeting detail page shows a QR code encoding the voter URL (`/vote/{meeting_id}`)
- [ ] The QR code is generated entirely client-side; a suitable JS library (e.g., `qrcode.react`) is used
- [ ] The tenant logo (from `BrandingContext.logo_url`) is rendered in the centre of the QR code when `logo_url` is non-empty
- [ ] Clicking the QR code opens a modal with a larger version of the same QR code for easier scanning or display on a projector
- [ ] The modal contains a "Download PNG" button that triggers a client-side download; filename is `agm-qr-{meeting_id}.png`
- [ ] The modal contains a "Print" button that calls `window.print()` scoped to the QR image only
- [ ] The modal is dismissible via a close button or clicking outside
- [ ] The QR code is present for both open and closed meetings
- [ ] All tests pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-030: Responsive voting layout and lot selection shortcuts

**Status:** ✅ Implemented

**Description:** As a lot owner on any device, I want the voting page to make good use of screen space and allow quick lot selection.

**Acceptance Criteria:**

- [ ] The voter content wrapper has a max-width of 1280px on desktop, with sensible padding (24px) on wide screens; 16px left/right padding on mobile (≤640px)
- [ ] In the lot sidebar, four shortcut buttons appear above the lot list for multi-lot voters: **Select All**, **Deselect All**, **Select Proxy Lots**, **Select Owned Lots**
- [ ] Shortcut buttons use `.btn.btn--secondary` style with `font-size: 0.75rem; padding: 3px 10px`
- [ ] On mobile (≤640px) the lot sidebar is collapsible via a toggle button; default state is **collapsed**; toggle button has `aria-expanded` attribute
- [ ] Admin pages use 16px padding on mobile; the `admin-page-header` stacks vertically on mobile
- [ ] Admin tables are wrapped in a scrollable container (`overflow-x: auto`)
- [ ] Typecheck/lint passes

---

### US-UI06: Motion card typography improvements

**Status:** ✅ Implemented

**Acceptance Criteria:**

- [ ] Motion card title renders at `1.375rem`, `font-weight: 700`
- [ ] Description text has `margin-top: 10px` (from 7px) and `line-height: 1.65`
- [ ] The "Already voted" badge renders as a styled grey pill
- [ ] All existing `MotionCard` tests continue to pass at 100% coverage
- [ ] Typecheck/lint passes

---

### US-UI07: Admin label typography consistency

**Status:** ✅ Implemented

**Acceptance Criteria:**

- [ ] All occurrences of `<h3 className="admin-card__title">` render in Outfit sans-serif (not Cormorant Garamond serif)
- [ ] Letter-spacing for admin label classes (`.admin-card__title`, `.admin-stats__label`, `.section-label`, `.motion-entry__header`) is uniformly `0.09em`
- [ ] The voter-facing `.vote-summary__heading` on the confirmation page also uses `0.09em` letter-spacing
- [ ] No `.tsx` files are modified — all changes are CSS-only
- [ ] Typecheck/lint passes

---

### US-TECH01: Vercel Analytics and Speed Insights

**Status:** ✅ Implemented

**Acceptance Criteria:**

- [x] `@vercel/analytics` and `@vercel/speed-insights` packages added to frontend dependencies
- [x] `<Analytics />` and `<SpeedInsights />` components mounted in `App.tsx`
- [x] Both components are mocked in frontend unit tests
- [x] Typecheck/lint passes

---

### US-TECH02: Fix browser caching of index.html

**Status:** ✅ Implemented

**Acceptance Criteria:**

- [x] `index.html` is served with `Cache-Control: no-cache, no-store, must-revalidate`
- [x] Hashed asset files (JS/CSS bundles under `/assets/`) are served with `Cache-Control: public, max-age=31536000, immutable`
- [x] Typecheck/lint passes

---

### US-UI-FIX-01: Admin and voter header logo fills nav bar

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As a user, I want the tenant logo to be displayed at a comfortable size in both the admin sidebar and the voter header so it is clearly legible without overflowing its container.

**Acceptance Criteria:**

- [ ] The admin sidebar logo (`admin-sidebar__logo`) is rendered at `40px` height with `auto` width
- [ ] The voter header logo (`app-header__logo`) is rendered at `40px` height with `auto` width
- [ ] Both logos remain vertically centred within their respective bars
- [ ] On mobile, neither logo overflows outside its container
- [ ] Typecheck/lint passes

---

### US-UI-FIX-02: Admin in-person "All answered" badge requires multi-choice interaction

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As an admin entering in-person votes, I want the "All answered" badge on a lot's column header to appear only after I have interacted with every motion — including multi-choice motions — so that I am not misled into thinking I have finished when I have only answered the binary motions.

**Acceptance Criteria:**

- [ ] The "All answered" badge is shown only when every visible motion (binary and multi-choice) has at least one input from the admin
- [ ] For binary motions: a choice in `For`/`Against`/`Abstain` counts as answered
- [ ] For multi-choice motions: at least one option must have a `For`/`Against`/`Abstain` selection before the motion counts as answered
- [ ] A multi-choice motion with no options touched does NOT count as answered for badge purposes
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-03: Admin in-person duplicate submission prevention

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As an admin, I want clear feedback when a lot I am trying to submit votes for already has a submitted ballot, so I can avoid errors and understand why the submission was rejected.

**Acceptance Criteria:**

- [ ] In step 2 of the vote entry grid, if a selected lot's `lot_number` is already in the submitted ballot set, an "Already submitted" badge is shown in that lot's column header
- [ ] If the backend returns a 409 error on submission, the error message reads: "One or more selected lots already have a submitted ballot. Go back to step 1 and deselect those lots."
- [ ] Non-409 submission errors continue to display the raw error message
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-04: Admin in-person vote entry success modal

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As an admin, I want a modal confirmation after submitting in-person votes so that I am required to explicitly acknowledge the success and cannot accidentally miss the notification.

**Acceptance Criteria:**

- [ ] After `AdminVoteEntryPanel` calls `onSuccess()`, a modal dialog is shown with the heading "Votes submitted" and body text confirming the votes were recorded
- [ ] The modal has a single "OK" button that dismisses it
- [ ] Pressing Escape also dismisses the modal
- [ ] The previous green banner for this event is removed
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-05: Per-motion drill-down in results report

**Status:** ✅ Implemented — branch: `fix/ui-updates`, committed 2026-04-12

**Description:** As an admin reviewing meeting results, I want to expand individual motions to see the detailed voter list, rather than toggling the entire results section, so I can inspect specific motions without the page collapsing all data at once.

**Acceptance Criteria:**

- [ ] The global "Results Report" collapse/expand toggle is removed; the report is always visible
- [ ] Each binary motion card has a "▶ Show voters" / "▲ Hide voters" toggle button in its header
- [ ] Clicking "Show voters" expands an inline voter list for that motion showing: category (For/Against/etc.), lot number, voter email, entitlement (UOE), and submitted-by (Admin/Voter)
- [ ] Voter lists are collapsed by default; each motion expands independently
- [ ] Multi-choice motions retain their existing per-option expand/collapse controls
- [ ] The `aria-expanded` attribute on each toggle button reflects the current state
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-06: Admin sidebar logo fills sidebar width; voter header logo increased to 100px

**Status:** ✅ Implemented — branch: `fix/ui-minor`, committed 2026-04-12

**Description:** As a user, I want the tenant logo to be prominently displayed in both the admin sidebar and voter header at a size that makes it clearly legible, rather than capped at the old 40px height.

**Acceptance Criteria:**

- [ ] The admin sidebar logo (`admin-sidebar__logo`) fills the sidebar's available content width (`width: 100%; max-width: 100%; height: auto`) so it scales with its own aspect ratio rather than being fixed to 40px height
- [ ] The voter header logo (`app-header__logo`) is rendered at `100px` height with `auto` width
- [ ] The voter header (`app-header`) is increased to `120px` height to accommodate the taller logo without clipping
- [ ] Both logos remain vertically centred within their respective containers
- [ ] On mobile, neither logo overflows outside its container
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-07: Vote drill-down button renamed to "Show voting details"

**Status:** ✅ Implemented — branch: `fix/ui-minor`, committed 2026-04-12

**Description:** As an admin, I want the expand/collapse button on each binary motion result card to be labelled "Show voting details" / "Hide voting details" so its purpose is unambiguous, and to be visually weighted to match adjacent heading-level controls.

**Acceptance Criteria:**

- [ ] The per-binary-motion toggle button in the Results Report section reads "▶ Show voting details" when collapsed and "▲ Hide voting details" when expanded
- [ ] The per-option toggle button in multi-choice motion result rows also reads "▶ Show voting details" / "▲ Hide voting details" (previously "Show voters" / "Hide voters")
- [ ] `aria-label` on each button contains "voting details" rather than "voter list" or "voters"
- [ ] Button font size is increased from `0.75rem` to `0.8125rem` with padding `3px 10px` (matching `.btn--admin` scale)
- [ ] Button text colour uses `var(--text-secondary)` rather than `var(--text-muted)` for better contrast
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-UI-FIX-08: Vote drill-down shows tabular voter list

**Status:** ✅ Implemented — branch: `fix/ui-minor`, committed 2026-04-12

**Description:** As an admin reviewing meeting results, I want the expanded voter detail section to display voters in an aligned table — with columns for Lot #, Email, UOE, Submitted By, and Choice — so I can scan and compare individual votes quickly.

**Acceptance Criteria:**

- [ ] When a binary motion's voter details are expanded, they are displayed as an `.admin-table` inside an `.admin-table-wrapper`
- [ ] The table has 5 columns: "Lot #" (monospace), "Email", "UOE" (monospace, right-aligned), "Submitted By", "Choice"
- [ ] Voters from all categories (For, Against, Abstained, Absent, Not eligible) appear in the same table, each row labelled with a coloured choice badge in the Choice column
- [ ] Proxy voters show "(proxy)" next to their email address
- [ ] Admin-submitted ballots show "Admin" in the Submitted By column; voter-submitted ballots show "Voter"
- [ ] If no voters exist across all categories, a "No voter records." message is shown instead of an empty table
- [ ] Typecheck/lint passes; all tests pass at 100% coverage

---

### US-DL-01: Per-motion vote results download

**Status:** ✅ Implemented

**Implementation note:** Client-side CSV generation from already-fetched data in `frontend/src/components/admin/AGMReportView.tsx`. No backend endpoint required.

**Description:** As a meeting admin reviewing results, I want to download the vote data for a single motion as a CSV file so I can inspect or archive individual motion outcomes without exporting the full meeting report.

**Acceptance Criteria:**

- [x] Each motion card in the Results Report section has a "Download CSV" button in its header row
- [x] The button is disabled (and marked `aria-disabled="true"`) when the motion has zero voter records across all categories (no For, Against, Abstained, Absent, or Not eligible rows)
- [x] Clicking an enabled button triggers a browser download with no page navigation or loading state (client-side generation from already-fetched data)
- [x] The downloaded filename follows the pattern `<motion_number>-<motion_title_slug>_results.csv` (e.g. `1-elect-chairperson_results.csv`); if `motion_number` is absent, `display_order` is used instead
- [x] For binary motions, the CSV contains one row per voter with columns: `Lot Number`, `Owner Name`, `Voter Email`, `Vote Choice`, `Entitlement (UOE)`, `Submitted By`, `Submitted At`
- [x] For multi-choice motions, the CSV contains one row per voter per option-vote with columns: `Lot Number`, `Owner Name`, `Voter Email`, `Option`, `Vote Choice`, `Entitlement (UOE)`, `Submitted By`, `Submitted At`
- [x] `Owner Name` is the display name from `voter_name` if available, empty string otherwise
- [x] `Vote Choice` values are human-readable: `For`, `Against`, `Abstained`, `Absent`, `Not eligible`
- [x] `Submitted By` is `Admin` when `submitted_by_admin = true`, `Voter` otherwise
- [x] `Submitted At` is the ballot submission timestamp in ISO 8601 format (UTC)
- [x] The button uses `.btn.btn--admin` style with a download icon (`↓`) prefix
- [x] All tests pass at 100% coverage
- [x] Typecheck/lint passes

---

## Non-Goals

- No admin vote entry for meetings that are already closed
- No overriding or amending app-submitted ballots via admin vote entry
- QR code customisation is limited to the tenant logo in the centre (no colour or style options)
- Automatically resolving multi-choice ties is not supported (admin must resolve manually)
- Voter name column in the drill-down table (requires backend query change; tracked as a separate story)
