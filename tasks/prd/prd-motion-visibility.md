# PRD: Motion Visibility Toggle

## Introduction

Admins running a General Meeting want to control which motions are visible to voters at any given time, enabling a phased release of motions during the meeting. A hidden motion does not appear on the voter's voting page; revealing it makes it appear immediately on the next page load. Voters can always see motions they have already voted on (read-only), and the voter summary shows everything they submitted.

---

## Goals

- Admins can show or hide any motion at any time while a meeting is `open` or `pending`
- Hidden motions do not appear on the voter voting page
- Newly revealed motions appear on the voter's next page load (refresh acceptable)
- Voters who have already submitted votes for some motions can return to vote on newly visible motions
- Previously submitted votes are always shown to the voter as read-only regardless of current visibility
- Vote completion is determined by the set of currently visible motions, not all motions
- Hidden motions remain visible to admins in the meeting detail and tally, clearly marked as hidden

---

## User Stories

### US-MV01: Add `is_visible` field to Motion model

**Description:** As a developer, I need to store a visibility flag on each motion so the backend can filter what voters see.

**Acceptance Criteria:**
- [ ] Add `is_visible` boolean column to the `motions` table, default `true`
- [ ] Alembic migration generated and runs cleanly against dev and test DBs
- [ ] Existing motions default to `is_visible = true` (no behaviour change for existing meetings)
- [ ] `MotionOut` Pydantic schema (voting.py) includes `is_visible: bool`
- [ ] `MotionOut` Pydantic schema (admin.py) includes `is_visible: bool`
- [ ] `MotionDetail` Pydantic schema (admin.py) includes `is_visible: bool`
- [ ] Typecheck/lint passes

---

### US-MV02: Backend endpoint to toggle motion visibility

**Description:** As a developer, I need an API endpoint so the admin UI can toggle a motion's visibility.

**Acceptance Criteria:**
- [ ] `PATCH /api/admin/motions/{motion_id}/visibility` accepts `{ "is_visible": bool }` and updates the field
- [ ] Returns 200 with the updated motion object on success
- [ ] Returns 404 if the motion does not exist
- [ ] Returns 409 if the meeting is `closed` (toggling is not allowed on closed meetings)
- [ ] Returns 409 if attempting to set `is_visible=false` on a motion that has received votes (at least one submitted `Vote` record exists for that motion)
- [ ] Returns 403 if the caller is not an authenticated admin
- [ ] Integration tests cover: toggle on, toggle off (no votes), 404, 409 (closed meeting), 409 (has votes), 403
- [ ] Typecheck/lint passes

---

### US-MV03: Admin UI — visibility toggle on motion list

**Description:** As a building manager, I want to toggle the visibility of each motion from the meeting detail page so I can control which motions are live during the meeting.

**Acceptance Criteria:**
- [ ] Each motion row in the admin meeting detail page shows a visibility toggle (e.g. an eye icon or on/off switch)
- [ ] The toggle reflects the current `is_visible` state
- [ ] Clicking the toggle calls `PATCH /api/admin/motions/{motion_id}/visibility` and updates the UI immediately on success
- [ ] Hidden motions are visually distinguished in the admin list (e.g. dimmed row, "Hidden" badge)
- [ ] The toggle is disabled (greyed out) when the meeting is `closed`
- [ ] A loading state is shown on the toggle while the request is in flight
- [ ] Error state shown if the request fails (does not change toggle state)
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MV04: Voter voting page — only show visible motions and already-voted motions

**Description:** As a voter, I want to see only the motions that are currently active, plus any motions I have already voted on, so I am not confused by motions that haven't been opened yet.

**Acceptance Criteria:**
- [ ] The voter voting page fetches motions via the existing meeting/motions endpoint
- [ ] Only motions with `is_visible = true` OR motions the voter has already submitted a vote for are shown
- [ ] A motion the voter has already voted on is shown in read-only mode (vote selection displayed, cannot be changed) regardless of its current `is_visible` state
- [ ] A motion that is visible and not yet voted on is shown as a normal votable motion card
- [ ] "Submit" / "Continue" is enabled when all **currently visible** motions have a selection (previously submitted motions do not need to be re-selected)
- [ ] If there are no visible motions and no previously submitted motions, the voting page shows a message such as "No motions are available yet. Please check back shortly."
- [ ] No hint text is shown to voters about how many total motions exist or whether more will be revealed — newly revealed motions simply appear on the next page refresh
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MV05: Allow re-entry voting for newly visible motions

**Description:** As a voter who has already submitted votes, I want to return to the voting page and vote on a newly revealed motion so I am not locked out just because I voted earlier.

**Acceptance Criteria:**
- [ ] A voter who has a `BallotSubmission` record for the meeting can still access the voting page if there are visible motions they have not yet voted on
- [ ] The `POST /api/auth/verify` response includes `unvoted_visible_count: int` — the count of currently visible motions that the voter (across all their lots) has not yet submitted a vote for
- [ ] If `unvoted_visible_count > 0`, the frontend routes to the voting page, not confirmation, even if the voter has existing submissions
- [ ] The voter can submit a vote for the newly visible motion without affecting their previous vote records
- [ ] After submitting the new motion's vote, if all visible motions are now voted on, the voter is navigated to the confirmation/summary page
- [ ] The backend records the new vote under the same `BallotSubmission` (or creates a new one per the existing model) without duplicating or overwriting existing vote records
- [ ] Integration tests: voter submits partial, admin reveals new motion, voter re-enters and submits new motion, all votes present in DB
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MV06: Voter summary/confirmation page — show all submitted motions

**Description:** As a voter, I want the confirmation page to show all motions I have voted on (even if some are now hidden) so I have a complete record of my participation.

**Acceptance Criteria:**
- [ ] The voter confirmation/summary page lists every motion the voter has submitted a vote for, with their recorded vote
- [ ] Motions that are currently hidden but were voted on are still shown (visibility flag does not filter the summary)
- [ ] Motions the voter has not voted on (hidden or not) are not shown on the summary
- [ ] The display order matches the motion `order_index`
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

### US-MV07: Admin report — mark hidden motions in tally

**Description:** As a building manager, I want the admin meeting report to show all motions (including hidden ones) clearly marked so I have a complete picture of all votes cast.

**Acceptance Criteria:**
- [ ] The admin meeting detail / report view shows all motions regardless of `is_visible`
- [ ] Motions with `is_visible = false` are labelled with a "Hidden" badge in the tally view
- [ ] Tally data (voter count, entitlement sums) is still computed and displayed for hidden motions
- [ ] Typecheck/lint passes
- [ ] Verify in browser using dev-browser skill

---

## Functional Requirements

- FR-1: `motions` table has an `is_visible` boolean column, default `true`
- FR-2: `PATCH /api/admin/motions/{motion_id}/visibility` toggles visibility; forbidden on closed meetings; also returns 409 if attempting to hide a motion that has received votes (at least one submitted Vote record exists for that motion)
- FR-3: Admin meeting detail page shows a visibility toggle per motion; hidden motions are visually distinguished
- FR-4: Voter voting page shows only visible motions plus previously-voted motions (read-only); server-side filtering ensures hidden motion titles are never sent to the browser for unvoted motions
- FR-5: Voting completion is determined by whether all currently visible motions have a submitted vote — previously submitted votes on hidden motions count toward completion
- FR-6: A voter with a prior `BallotSubmission` is allowed re-entry to the voting page if there are visible motions they have not voted on
- FR-7: Re-entered vote is appended to the existing submission; no prior vote records are modified
- FR-8: Voter summary/confirmation page shows all motions the voter submitted votes for, regardless of current visibility
- FR-9: Admin report shows all motions (visible and hidden) with a "Hidden" badge on hidden ones
- FR-10: Visibility toggle is only available when meeting status is `open` or `pending`; disabled for `closed` meetings

---

## Non-Goals

- No real-time push to voter screens — a page refresh is the required mechanism for voters to see newly revealed motions
- No per-voter visibility control — visibility is global for all voters in a meeting
- No scheduling or time-based auto-reveal of motions
- No "more motions coming" hint text shown to voters — newly revealed motions appear silently on next refresh
- No change to how the meeting close logic assigns absent votes — absent logic is unchanged

---

## Technical Considerations

- **Re-entry guard (`POST /api/auth/verify`):** Currently returns `agm_status` to tell the frontend whether to redirect to confirmation. This logic must be updated: a voter is only "done" if every visible motion has a submitted vote. The endpoint should compute `unvoted_visible_count` and return it so the frontend can decide whether to go to voting or confirmation.
- **Vote deduplication:** The backend must guard against a voter submitting a second vote for the same motion (which could happen if the voter manipulates state). Return 409 if a vote for `(ballot_submission_id, motion_id)` already exists.
- **Tally impact:** Hidden motions still accumulate votes normally; the tally displayed in the admin view must include them. The auto-close absent logic runs over all motions (visible or not) at meeting close — this is unchanged.
- **`MotionOut` schema:** Add `is_visible: bool` field. The voter-facing motions list endpoint should filter server-side, not client-side, to avoid leaking hidden motion titles to the browser. Exception: motions the voter has already submitted a vote for are always returned even if hidden, so the voter can see their submitted vote as read-only.

---

## Success Metrics

- Admin can reveal a motion and a voter sees it on their next page refresh with no manual cache clearing
- Voters who have partially voted can re-enter the voting page and vote on newly revealed motions without losing prior votes
- All votes (including those on hidden motions) are correctly tallied in the admin report

---

## Open Questions

All open questions resolved:

1. **Should an admin be able to hide a motion that already has votes?** — **Resolved: 1A (Block).** An admin cannot hide a motion that already has votes. The `PATCH /api/admin/motions/{id}/visibility` endpoint returns 409 with "Cannot hide a motion that has received votes" if any submitted `Vote` records exist for that motion.

2. **Should the voter voting page show a hint like "X of Y motions available"?** — **Resolved: 2A (Silent).** No hint text is shown to voters. Newly revealed motions just appear on the next page refresh with no messaging.
