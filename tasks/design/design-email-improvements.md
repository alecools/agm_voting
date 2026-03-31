# Design: Email Improvements (US-EMAIL-01, US-EMAIL-02, US-EMAIL-03)

**Status:** Implemented

## Overview

Three small improvements to the voting summary email and the admin meeting detail page:

1. **Multi-choice voter listing in email** — the email template already renders per-voter lists for yes/no/abstained/absent categories but silently omits per-option voter lists for multi-choice motions. The backend already computes `voter_lists.options` (a dict of `option_id → [voter]`), so only the Jinja2 template needs updating.

2. **Motion resolution type in email** — the backend already passes `motion_type` (`"general"` or `"special"`) in each motion dict, but the template never renders it. Adding a single line under the motion title label is a template-only change.

3. **Resend summary email button** — the backend already has `POST /api/admin/general-meetings/{id}/resend-report` and the TypeScript client function `resendReport()`, but the button is only surfaced inside the `EmailStatusBanner` (shown only when delivery has `status === "failed"`). The requirement is to show a standalone button whenever the meeting is closed, regardless of delivery status. The backend service guard (`status must be "failed"`) must be relaxed to allow any closed meeting to be re-queued.

---

## Root Cause / Background

**Feature 1:** `report_email.html` iterates `motion.voter_lists.yes/no/abstained/absent` but has no block for `motion.voter_lists.options`. The dict is already populated by `get_general_meeting_detail` in `admin_service.py` (lines 1421–1435), keyed by stringified `option_id` and containing voter dicts identical in shape to the yes/no voter lists.

**Feature 2:** The template uses `motion.motion_number` (line 77) but never uses `motion.motion_type`. The service already passes `motion_type` (line 1443 / 1501) as a string value `"general"` or `"special"`.

**Feature 3:** `admin_service.resend_report` (line 2024) raises `HTTPException(409)` if `delivery.status != EmailDeliveryStatus.failed`. This prevents the admin from re-triggering on a `pending` or `delivered` meeting. The `EmailStatusBanner` component is the only UI entry point for resend and is only displayed when `email_delivery.status === "failed"`.

---

## Technical Design

### Database changes

None. `motion_type` is already on the `motions` table. `voter_lists.options` is computed at query time. No new columns, tables, or enum values.

### Backend changes

#### `backend/app/templates/report_email.html`

**Feature 1 — multi-choice option voter lists:**

After the existing `{% if motion.voter_lists.absent %}` block (line 204), add a new conditional block that renders only when `motion.is_multi_choice` is true. Iterate over `motion.options` to obtain each option's text and `id`; use `motion.voter_lists.options[opt.id | string]` to retrieve the voter list for that option. Each voter row matches the existing format: `Lot {{ voter.lot_number }} | {{ voter.voter_email }}` with entitlement right-aligned.

The section header label for each option uses a neutral colour (e.g. `#1a3c5e` — the brand blue) to distinguish it from the green/red Yes/No headers.

```
{% if motion.is_multi_choice %}
  {% for opt in motion.options %}
    {% set opt_voters = motion.voter_lists.options.get(opt.id | string, []) %}
    {% if opt_voters %}
      <!-- Voted for <option text> voter list -->
      <tr><td ...>
        <div>Voted: {{ opt.option_text }}</div>
        <table>{% for voter in opt_voters %}...{% endfor %}</table>
      </td></tr>
    {% endif %}
  {% endfor %}
{% endif %}
```

Note: `motion.options` is already included in the motion dict returned by `get_general_meeting_detail` (line 1447–1450); it is an array of `{id, text, display_order}` dicts.

**Feature 2 — motion resolution type label:**

In the motion header cell (after line 78, the `motion.title` div), add:

```html
<div style="font-size:11px;color:#888888;margin-top:2px;">
  {% if motion.motion_type == "special" %}Special Resolution{% else %}General Resolution{% endif %}
</div>
```

This requires no change to `email_service.py` — `motion_type` is already in the template context.

#### `backend/app/services/admin_service.py` — `resend_report` function

**Feature 3 — relax the `status != "failed"` guard:**

Current guard (lines 2024–2028):
```python
if delivery.status != EmailDeliveryStatus.failed:
    raise HTTPException(
        status_code=409,
        detail=f"Email delivery status is '{delivery.status.value}', not 'failed'",
    )
```

Replace with: allow resend for any status. The only hard precondition is that the meeting is closed (already checked above, lines 2013–2014) and that an `EmailDelivery` record exists (lines 2021–2022). Remove the status check entirely. Reset `delivery.status`, `delivery.total_attempts`, `delivery.last_error`, and `delivery.next_retry_at` unconditionally.

No other backend changes are needed.

#### No changes needed to `email_service.py`

`EmailService.send_report` uses `get_general_meeting_detail` which already returns `motion_type` and `voter_lists.options` for each motion. The email template is the sole consumer.

### Frontend changes

#### `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

**Feature 3 — resend button:**

Add a new `useMutation` for resend. The API function `resendReport` already exists in `frontend/src/api/admin.ts` (line 477). Add state variables:

```typescript
const [resendSuccess, setResendSuccess] = useState(false);
const [resendError, setResendError] = useState<string | null>(null);
```

Add a `resendMutation` using `useMutation`:
```typescript
const resendMutation = useMutation({
  mutationFn: () => resendReport(meetingId!),
  onSuccess: () => { setResendSuccess(true); setResendError(null); },
  onError: (err: Error) => { setResendError(err.message); setResendSuccess(false); },
});
```

Render the button in the action header area alongside the existing Close/Delete buttons, conditionally on `meeting.status === "closed"`:

```tsx
{meeting.status === "closed" && (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <button
      type="button"
      className="btn btn--secondary"
      onClick={() => { setResendSuccess(false); setResendError(null); resendMutation.mutate(); }}
      disabled={resendMutation.isPending}
    >
      {resendMutation.isPending ? "Sending…" : "Resend Summary Email"}
    </button>
    {resendSuccess && (
      <span style={{ color: "var(--green)", fontSize: "0.875rem", fontWeight: 600 }}>
        Queued for resend.
      </span>
    )}
    {resendError && (
      <span role="alert" style={{ color: "var(--red)", fontSize: "0.875rem" }}>
        {resendError}
      </span>
    )}
  </div>
)}
```

The import of `resendReport` is added to the existing import from `../../api/admin`.

#### `frontend/src/api/admin.ts`

No changes needed. `resendReport` (line 477) and `ResendReportOut` (line 153) already exist.

#### `frontend/tests/msw/handlers.ts`

The existing handler for `POST .../resend-report` (lines 632–638) already covers success and 409 failure. A new fixture meeting ID (e.g. `"agm-closed-resend"`) may be needed for tests that verify the button is visible on a closed meeting without a failed delivery status. The existing `ADMIN_MEETING_DETAIL_CLOSED` fixture can serve this purpose if it doesn't already set `email_delivery.status = "failed"` — verify during implementation.

---

## Data Flow (happy path for feature 3 — resend)

1. Admin opens the meeting detail page for a closed meeting.
2. `GET /api/admin/general-meetings/{id}` returns `status: "closed"`. The "Resend Summary Email" button is visible.
3. Admin clicks the button. Frontend calls `POST /api/admin/general-meetings/{id}/resend-report`.
4. `resend_report()` service verifies meeting is closed, finds the `EmailDelivery` record, resets it to `pending`, commits.
5. Router schedules `email_service.trigger_with_retry(meeting_id)` as a FastAPI `BackgroundTask`.
6. Response `{ queued: true }` returns 200. Frontend shows "Queued for resend." confirmation.
7. Background task calls `send_report()`, renders the updated email template (with option voter lists and resolution type labels), sends via SMTP.

---

## Implementation Ordering

Follow the project's implementation ordering rule: backend before frontend.

**Backend (all in one pass — no migration needed):**
1. `report_email.html` — add resolution type label (Feature 2) and per-option voter lists (Feature 1)
2. `admin_service.py` — remove the `status != "failed"` guard in `resend_report` (Feature 3)
3. Update backend unit tests for `resend_report` to cover the relaxed guard
4. Update backend integration tests to assert the email template renders option voter lists and the resolution type label

**Frontend (after backend):**
1. `GeneralMeetingDetailPage.tsx` — add resend button, import `resendReport`
2. Add/update MSW handler fixture for a closed meeting with non-failed delivery status if needed
3. Add unit tests for the new button: loading state, success state, error state
4. Verify E2E test (admin journey) is unaffected or update as needed

---

## Security Considerations

- **Authentication:** `POST /api/admin/general-meetings/{id}/resend-report` is already under the `require_admin` dependency (line 56 of `admin.py`). No change needed.
- **Input validation:** The endpoint takes only a path parameter (UUID), validated by FastAPI. No body.
- **Session/cookies:** No changes.
- **Secrets:** No new credentials. SMTP credentials already configured.
- **Rate limiting:** No new rate limiting needed. The resend operation resets the exponential backoff counter (total_attempts = 0), effectively giving a fresh 30-attempt budget. An admin would need to deliberately hammer the button to cause any concern; admin actions are already authenticated.
- **Data exposure:** The email template changes expose lot numbers, voter emails, and entitlements — the same data already in the email. Scope is unchanged (sent only to the building's manager email).

---

## Files to Change

| File | Change |
|------|--------|
| `backend/app/templates/report_email.html` | Add resolution type label to motion header (Feature 2); add per-option voter list blocks inside `{% if motion.is_multi_choice %}` (Feature 1) |
| `backend/app/services/admin_service.py` | Remove `status != "failed"` guard in `resend_report`; reset delivery unconditionally (Feature 3) |
| `backend/tests/test_admin_service.py` (or equivalent) | Add/update test for `resend_report` with `status = "pending"` and `status = "delivered"` — both should now succeed |
| `backend/tests/test_email_service.py` (or equivalent) | Add tests asserting rendered HTML contains resolution type label and option voter lists |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Add `resendReport` import, `resendMutation`, state vars, and resend button (Feature 3) |
| `frontend/tests/msw/handlers.ts` | Add fixture ID for closed-meeting-non-failed-delivery if needed for resend button tests |
| `frontend/tests/` (relevant page test file) | Add unit tests: resend button renders when closed, shows loading, shows success, shows error |

---

## Test Cases

### Unit / Integration

**Feature 1 — multi-choice voter listing:**
- Render the email template with a multi-choice motion that has `voter_lists.options` populated → assert each option's voter list section appears in the HTML output
- Motion with no voters for a specific option → assert that option's voter list section is absent (empty `opt_voters`)
- Mix of multi-choice and yes/no motions in same email → assert both render correctly

**Feature 2 — resolution type label:**
- Render template with `motion_type = "general"` → assert "General Resolution" appears in output
- Render template with `motion_type = "special"` → assert "Special Resolution" appears in output
- Multi-choice motion with `motion_type = "special"` → assert label appears

**Feature 3 — relaxed resend guard:**
- `resend_report` with `delivery.status = "failed"` → 200, delivery reset to pending (existing test, verify still passes)
- `resend_report` with `delivery.status = "pending"` → 200, delivery reset to pending (previously 409, now succeeds)
- `resend_report` with `delivery.status = "delivered"` → 200, delivery reset to pending (previously 409, now succeeds)
- `resend_report` when meeting not found → 404
- `resend_report` when meeting is open (not closed) → 409
- `resend_report` when `EmailDelivery` record not found → 404

**Frontend unit tests for resend button:**
- Meeting status `"closed"` → "Resend Summary Email" button rendered
- Meeting status `"open"` → button not rendered
- Meeting status `"pending"` → button not rendered
- Click resend → mutation fires, button shows "Sending…" while pending
- On success → shows "Queued for resend." text
- On error → shows inline error message with `role="alert"`

### E2E

No new E2E scenarios are required for Features 1 and 2 (email rendering is not exercised by the Playwright suite — it fires against SMTP). Feature 3 requires:

- **Admin resend button visible on closed meeting:** open the admin meeting detail page for a closed meeting → "Resend Summary Email" button is visible
- **Resend button triggers queue:** click "Resend Summary Email" → "Queued for resend." confirmation appears

---

## E2E Test Scenarios

### New scenarios (Feature 3)

1. **Happy path — resend from closed meeting:**
   - Admin logs in, navigates to a closed meeting.
   - "Resend Summary Email" button is present.
   - Click button → loading indicator appears → "Queued for resend." message appears.

2. **Error state:**
   - Mock the resend endpoint to return 409.
   - Click button → inline error message appears with the server error detail.

3. **Button absent on open meeting:**
   - Navigate to an open meeting → verify "Resend Summary Email" button is not in DOM.

### Existing E2E specs affected

The **Admin persona journey** (`admin → login → building/meeting management → report viewing → close meeting`) touches `GeneralMeetingDetailPage`. Existing specs that assert the header action buttons on a closed meeting must be verified to still pass — they should be unaffected because the new button is additive. No existing E2E test exercises the `EmailStatusBanner` resend flow specifically (it is unit-tested), so there is no overlap.

---

## Vertical Slice Decomposition

All three features are small and share the same pair of files (`report_email.html` for Features 1 & 2, `GeneralMeetingDetailPage.tsx` for Feature 3). There are no cross-slice DB or API dependencies. They can be implemented sequentially in a single branch without meaningful conflict:

- Features 1 and 2 are both pure template changes — implement together.
- Feature 3 is a one-line backend guard removal plus a frontend button — implement after Features 1 & 2.

No decomposition into parallel branches is warranted for work of this size.

---

## Schema Migration Required

**No.** All required data (`motion_type`, `voter_lists.options`) is already computed from existing tables at query time. No new columns, tables, or enum values are added.
