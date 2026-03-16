# Technical Design: Email OTP Authentication

## Overview

Replace the current lot-number + email auth flow with a two-step email OTP flow. The voter enters their email, receives an 8-character alphanumeric code, and submits the code to authenticate. The backend response and session creation are unchanged — the OTP is purely a means of verifying email ownership before the existing `verify` logic runs.

---

## 1. Database Changes

### New table: `auth_otps`

```sql
CREATE TABLE auth_otps (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR NOT NULL,
    meeting_id    UUID NOT NULL REFERENCES general_meetings(id) ON DELETE CASCADE,
    code          VARCHAR(20) NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    used          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_auth_otps_email_meeting ON auth_otps (email, meeting_id);
CREATE INDEX ix_auth_otps_expires_at    ON auth_otps (expires_at);
```

**Column notes:**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Auto-generated |
| `email` | VARCHAR | Not normalised — stored exactly as supplied; matching is case-sensitive, consistent with existing `LotOwnerEmail.email` semantics |
| `meeting_id` | UUID FK → `general_meetings.id` | Scopes the OTP to a specific meeting; CASCADE on delete |
| `code` | VARCHAR(20) | Stored as plain alphanumeric string (see Security section below) |
| `expires_at` | TIMESTAMPTZ | Set to `now() + 5 minutes` at creation |
| `used` | BOOLEAN | Set to `TRUE` after a successful `verify` call; prevents replay |
| `created_at` | TIMESTAMPTZ | For audit and cleanup |

**Why not hash the code?** An 8-character alphanumeric code has ~36^8 ≈ 2.8 trillion possible values, which is large enough that brute-forcing against even an unsalted hash is impractical within the 5-minute window. The real security controls are: short expiry, single-use flag, and rate-limiting on the `request-otp` endpoint. Storing plain text keeps the verification query simple and fast.

**SQLAlchemy model** (`backend/app/models/auth_otp.py`):

```python
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuthOtp(Base):
    __tablename__ = "auth_otps"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String, nullable=False)
    meeting_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("general_meetings.id", ondelete="CASCADE"), nullable=False
    )
    code: Mapped[str] = mapped_column(String(6), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

### Migration approach

- Generate with `alembic revision --autogenerate -m "add auth_otps table"`
- The migration only adds a new table — no existing tables are modified
- Safe to run against the shared preview DB without a feature-isolated Neon branch (no schema changes to existing tables)

### OTP cleanup strategy

Expired OTPs accumulate but never affect correctness (they fail the `expires_at > now()` check). Two cleanup mechanisms:

1. **Lazy cleanup on request-otp**: when inserting a new OTP for a given `(email, meeting_id)` pair, delete all previous OTPs for that pair first. This keeps the table lean for the hot path.
2. **Periodic cleanup** (optional, out of scope for this slice): a background task or a Vercel cron job can `DELETE FROM auth_otps WHERE expires_at < now() - interval '1 day'`. Not required for correctness — omit for MVP.

---

## 2. Backend Changes

### New endpoint: `POST /api/auth/request-otp`

**File:** `backend/app/routers/auth.py` (add new route handler)

**Request schema** (`backend/app/schemas/auth.py`):

```python
class OtpRequestBody(BaseModel):
    email: str
    general_meeting_id: uuid.UUID

    @field_validator("email")
    @classmethod
    def email_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v
```

**Response schema:**

```python
class OtpRequestResponse(BaseModel):
    sent: bool  # always True on success; False branch never reached (errors raise HTTPException)
```

**Logic:**

1. Fetch the `GeneralMeeting` by `general_meeting_id`. Return 404 if not found.
2. Look up `LotOwnerEmail` + `LotProxy` records for `(email, building_id)` — same join as the existing `verify` endpoint. If no matching lots are found, return **200 with `sent: true`** — do NOT return 401 here. Revealing that the email is unknown is a user-enumeration vector; the error will surface naturally when `verify` is called with a valid code.
3. Delete any existing OTPs for `(email, meeting_id)` (lazy cleanup).
4. Generate an 8-character uppercase alphanumeric code: `''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))`. The alphabet omits `O`, `0`, `I`, `1` to avoid visual confusion.
5. Insert a new `AuthOtp` row with `expires_at = now() + timedelta(minutes=5)`.
6. Send the OTP email (see Email Content below).
7. Commit and return `{"sent": true}`.

**Error cases:**

| Condition | Response |
|---|---|
| Meeting not found | 404 `{"detail": "General Meeting not found"}` |
| Email field empty/missing | 422 (Pydantic validation) |
| SMTP failure | 500 — do not expose internal detail; log the error |

**Rate limiting:** Add a simple in-memory rate limiter (or rely on Vercel/CDN limits for MVP). Suggested approach: track `(email, meeting_id)` → last-sent timestamp in a module-level dict; reject if last send was < 60 seconds ago with 429 `{"detail": "Please wait before requesting another code"}`. This is a best-effort MVP control. A Redis-backed limiter can replace it later.

**OTP email content:**

Subject: `Your AGM Voting Code — {meeting_title}`

Body (plain text fallback + HTML):

```
Your one-time verification code for {meeting_title} is:

    {code}

This code expires in 5 minutes. Do not share it with anyone.

If you did not request this code, please ignore this email.
```

The HTML version wraps the code in a large monospaced span for legibility. Use the existing Jinja2 template system (`backend/app/templates/`). Create a new template: `otp_email.html`.

**Sender:** uses the existing `settings.smtp_from_email` — no new config variable needed.

---

### Modified endpoint: `POST /api/auth/verify`

**What changes:** The request body gains a `code` field; the `lot_number` field is removed entirely (it was already unused by the backend — the existing `AuthVerifyRequest` had only `email` and `general_meeting_id`). The new field `code` is added.

**Updated request schema:**

```python
class AuthVerifyRequest(BaseModel):
    email: str
    general_meeting_id: uuid.UUID
    code: str  # NEW — the OTP code

    @field_validator("email")
    @classmethod
    def email_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("email must not be empty")
        return v

    @field_validator("code")
    @classmethod
    def code_format(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("code must not be empty")
        return v.strip()
```

**Updated verify logic** (prepend to existing handler, before the lot-lookup queries):

1. Look up the most recent unused, unexpired `AuthOtp` for `(email, meeting_id)` where `used = FALSE AND expires_at > now()`.
2. If none found: raise 401 `{"detail": "Invalid or expired verification code"}`.
3. If `otp.code != request.code`: raise 401 `{"detail": "Invalid or expired verification code"}`. (Same message for both — no oracle attack.)
4. Mark `otp.used = TRUE` (flush, do not commit yet — commit happens at the end of the handler as before).
5. Continue with existing lot-lookup, session creation, and response logic unchanged.

**Why look up "most recent" OTP?** The user may have clicked "Resend code" — there could be multiple OTP rows for the same pair. We only accept the newest valid one; older ones become stale automatically (though they are deleted on the next resend).

**Error cases added:**

| Condition | Response |
|---|---|
| No valid OTP found | 401 `{"detail": "Invalid or expired verification code"}` |
| Code mismatch | 401 `{"detail": "Invalid or expired verification code"}` |

All existing error cases (meeting not found → 404, email not in meeting → 401) are unchanged.

---

## 3. Frontend Changes

### `AuthForm` component — two-step redesign

**File:** `frontend/src/components/vote/AuthForm.tsx`

**Props interface change:**

```typescript
// Old
interface AuthFormProps {
  onSubmit: (lotNumber: string, email: string) => void;
  isLoading: boolean;
  error?: string;
}

// New
interface AuthFormProps {
  onRequestOtp: (email: string) => void;
  onVerify: (email: string, code: string) => void;
  isRequestingOtp: boolean;
  isVerifying: boolean;
  error?: string;
}
```

**Internal state machine:**

```
idle
  → (user clicks "Send Verification Code") → sending
sending
  → (request-otp success) → code_sent
  → (request-otp error)   → idle  (error shown)
code_sent
  → (user clicks "Verify") → verifying
  → (user clicks "Resend code") → sending
verifying
  → (verify success) → (AuthPage handles navigation)
  → (verify error)   → code_sent  (error shown, code input cleared)
```

Internal state in the component: `step: "email" | "code"` (the loading states come from props).

**Step 1 — email input:**

- Single field: "Email address" (`<input type="email" id="email" />`), labelled with `<label htmlFor="email">Email address</label>`
- Button: "Send Verification Code" (`btn--primary btn--full`)
- Disabled while `isRequestingOtp` is true; button text: "Sending…" while loading
- On submit: validate email is non-empty; call `onRequestOtp(email)`

**Step 2 — code input:**

- Display: "We sent a verification code to {email}" as hint text
- Single field: "Verification code" (`<input type="text" inputMode="text" maxLength={20} id="otp-code" />`), labelled `<label htmlFor="otp-code">Verification code</label>`. Use `autoComplete="one-time-code"` for mobile autofill.
- Button: "Verify" (`btn--primary btn--full`)
- "Resend code" link/button below the form (plain button with ghost style): calls `onRequestOtp(email)` again; transitions back to step 1 visually (or stays on step 2 with a "Code sent!" flash)
- Disabled while `isVerifying` is true; button text: "Verifying…" while loading
- On submit: validate code is non-empty; call `onVerify(email, code)`
- Clear the code input on error (so the user doesn't re-submit the same wrong code)

**Accessibility:** each step's form has a meaningful `aria-live` region for error messages (already handled by `role="alert"` on error spans in the current component — retain this).

---

### `AuthPage` component changes

**File:** `frontend/src/pages/vote/AuthPage.tsx`

The page now manages two mutations instead of one:

```typescript
// Mutation 1: request OTP
const requestOtpMutation = useMutation({
  mutationFn: ({ email }: { email: string }) =>
    requestOtp({ email, general_meeting_id: meetingId! }),
  onError: () => setAuthError("Failed to send code. Please try again."),
});

// Mutation 2: verify OTP  (same post-success logic as current verifyAuth mutation)
const verifyMutation = useMutation({
  mutationFn: ({ email, code }: { email: string; code: string }) =>
    verifyAuth({ email, code, general_meeting_id: meetingId! }),
  onSuccess: (data) => { /* unchanged navigation logic */ },
  onError: (error: Error) => {
    if (error.message.includes("401")) {
      setAuthError("Invalid or expired code. Please try again.");
    } else {
      setAuthError("An error occurred. Please try again.");
    }
  },
});
```

The `handleSubmit` callback is replaced by two callbacks: `handleRequestOtp` and `handleVerify`.

The error message for 401 changes from `"Lot number and email address do not match our records"` to `"Invalid or expired code. Please try again."`.

---

### API layer changes

**File:** `frontend/src/api/voter.ts`

Add:

```typescript
export interface OtpRequestBody {
  email: string;
  general_meeting_id: string;
}

export interface OtpRequestResponse {
  sent: boolean;
}

export function requestOtp(req: OtpRequestBody): Promise<OtpRequestResponse> {
  return apiFetch<OtpRequestResponse>("/api/auth/request-otp", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
```

Modify `AuthVerifyRequest`:

```typescript
// Old
export interface AuthVerifyRequest {
  email: string;
  general_meeting_id: string;
}

// New
export interface AuthVerifyRequest {
  email: string;
  general_meeting_id: string;
  code: string;  // OTP code
}
```

---

### E2E helper changes

**File:** `frontend/e2e/workflows/helpers.ts`

`authenticateVoter` is the primary change point. All callers pass a `lotNumber` argument today; that argument is removed.

**Updated signature:**

```typescript
/**
 * Fill and submit the auth form via the two-step OTP flow.
 *
 * Step 1: fill email, click "Send Verification Code".
 * Step 2: intercept the OTP from the API response (via route interception),
 *         fill the code field, click "Verify".
 *
 * OTP retrieval strategy for E2E: the test environment must expose the OTP
 * without sending a real email. Two options (choose one at implementation time):
 *
 * Option A — Test-only API endpoint: add `GET /api/test/latest-otp?email=&meeting_id=`
 *   that returns the most recent unused OTP for that pair. Guard with
 *   `if settings.testing_mode` so it never exists in production.
 *
 * Option B — Intercept SMTP in tests: configure a test SMTP server (e.g. Mailpit)
 *   and parse the email body to extract the code.
 *
 * The design recommends Option A for simplicity. The implementation agent
 * must choose and document the final approach.
 */
export async function authenticateVoter(
  page: Page,
  email: string,
  getOtp: () => Promise<string>  // injected by the caller; retrieves OTP out-of-band
): Promise<void> {
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send Verification Code" }).click();
  // Wait for step 2 to appear
  await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
  const code = await getOtp();
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
}
```

`goToAuthPage` changes only the final assertion (it currently asserts `getByLabel("Email address")` — this remains valid since step 1 still has an email field, no change needed):

```typescript
// No change needed — the email label is present in step 1
await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });
```

**All callers of `authenticateVoter` in workflow specs** must be updated to:
1. Remove the `lotNumber` argument
2. Provide a `getOtp` callback — typically calling the test-only OTP endpoint

---

## 4. Slice Decomposition

### Slice A — Backend OTP infrastructure

**Branch:** `feat/otp-auth-backend`

**Scope:**
- New `AuthOtp` SQLAlchemy model (`backend/app/models/auth_otp.py`)
- Add `AuthOtp` to `backend/app/models/__init__.py`
- Alembic migration: `add_auth_otps_table`
- New Jinja2 template: `backend/app/templates/otp_email.html`
- New endpoint: `POST /api/auth/request-otp` in `backend/app/routers/auth.py`
- Updated `AuthVerifyRequest` schema (add `code` field) in `backend/app/schemas/auth.py`
- Updated `POST /api/auth/verify` handler: validate OTP before lot lookup
- New schemas: `OtpRequestBody`, `OtpRequestResponse` in `backend/app/schemas/auth.py`
- Test-only endpoint `GET /api/test/latest-otp` (guarded by `settings.testing_mode` env var)
- Backend unit tests: OTP generation, expiry logic, rate limit, request-otp handler, verify handler
- Backend integration tests: full request/response with test DB

**Does not touch:** any frontend file.

**Can be E2E tested in isolation?** Not fully — the UI is unchanged. Backend-only E2E: use Playwright API calls (no browser) to call `request-otp` then `verify` directly and assert the session cookie is returned. This is sufficient to validate Slice A independently.

---

### Slice B — Frontend auth form redesign

**Branch:** `feat/otp-auth-frontend`

**Depends on:** Slice A merged to `preview` first. The frontend must call the new `request-otp` endpoint; it cannot be fully wired without it. During local unit tests, MSW mocks both endpoints.

**Scope:**
- Updated `AuthForm` component: two-step UI
- Updated `AuthPage`: two mutations, new error messages
- Updated `frontend/src/api/voter.ts`: add `requestOtp`, update `AuthVerifyRequest`
- Updated `frontend/e2e/workflows/helpers.ts`: new `authenticateVoter` signature, remove `lotNumber`
- Update all workflow E2E specs that call `authenticateVoter` (remove `lotNumber` arg, add `getOtp` callback)
- Frontend unit tests: all step transitions, error states, resend flow
- Frontend integration tests: full form flow with MSW mocks

**Combination option:** Slices A and B can be combined into a single branch `feat/otp-auth` if the team is small enough that parallel execution provides no throughput benefit. The combined slice is still independently E2E-testable.

**Recommendation:** Combine into one branch. The backend and frontend changes for this feature are tightly coupled (new endpoint + UI that calls it), relatively small in total, and testing them together avoids the complexity of MSW-only frontend testing against a real API shape. A single branch `feat/otp-auth` is simpler.

---

## 5. Test Coverage Plan

### Backend unit tests

**OTP generation** (`tests/unit/test_auth_otp.py`):
- Generated code is always exactly 8 characters
- Generated code contains only characters from the allowed alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) — no `O`, `0`, `I`, `1`
- Two consecutive calls produce different codes (probabilistic; run 10 times)

**`POST /api/auth/request-otp`:**
- Happy path: valid email + meeting_id → 200 `{"sent": true}`, OTP row inserted, email sent
- Email not in meeting: still returns 200 `{"sent": true}` (enumeration protection), no OTP inserted, no email sent — **but the same response is returned either way**

  Wait — design decision needed: should we insert an OTP even if the email has no matching lots? If we skip insertion and still return 200, the attacker learns nothing. If `verify` is called with a code for a non-existent email, the OTP lookup will fail anyway (401). So: **do not insert OTP if email is not found in the building** — but return 200 regardless. This is safe: the code entered by the user will fail at `verify` with the generic 401 message.

- Expired meeting (voting_closes_at in past): still accept request-otp (the user can still authenticate to view their submission — closed AGMs allow verify per existing design)
- Meeting not found: 404
- Empty email: 422
- Rate limit triggered: 429
- Previous OTP for same (email, meeting_id) is deleted on new request

**`POST /api/auth/verify`:**
- Happy path: valid code, not expired, not used → 200 + session cookie + lots
- Invalid code (wrong digits): 401 `{"detail": "Invalid or expired verification code"}`
- Expired OTP (`expires_at` in past): 401
- Already-used OTP (`used = TRUE`): 401
- No OTP row exists: 401
- Existing verify error cases unchanged: meeting not found → 404, email not in meeting → 401

**State-based tests:**
- OTP used → second verify attempt → 401
- OTP expired → request new OTP → new code succeeds
- Resend: two OTPs exist for same pair; first is deleted on resend; second is valid

### Frontend unit tests

**`AuthForm` component:**
- Initial render: shows email field + "Send Verification Code" button; no code field
- Step 1 validation: empty email → shows inline error, does not call `onRequestOtp`
- After `onRequestOtp` succeeds (step transitions to "code"): shows "Verification code" field + "Verify" button + "Resend code" button; email field hidden
- Step 2 validation: empty code → shows inline error, does not call `onVerify`
- `isRequestingOtp=true`: "Send Verification Code" button disabled, text = "Sending…"
- `isVerifying=true`: "Verify" button disabled, text = "Verifying…"
- Error prop displayed in both steps
- Resend click: calls `onRequestOtp` again with current email
- Code input cleared when error is shown after verify failure

**`AuthPage` component:**
- `requestOtpMutation` failure → sets authError, stays on step 1
- `verifyMutation` 401 → sets authError with OTP-specific message
- `verifyMutation` success → navigates (same navigation assertions as current tests)
- `meetingId` undefined → requestOtp returns rejected promise (guarded by `/* c8 ignore next */`)

**API layer:**
- `requestOtp` calls `POST /api/auth/request-otp` with correct body (MSW mock)
- `verifyAuth` now sends `code` in request body (MSW mock)

### E2E tests

**Workflow specs to update** (remove `lotNumber` arg from all `authenticateVoter` calls):
- `frontend/e2e/workflows/voter-journey.spec.ts`
- `frontend/e2e/workflows/proxy-voter-journey.spec.ts`
- `frontend/e2e/workflows/in-arrear-voter.spec.ts`
- `frontend/e2e/workflows/closed-agm.spec.ts`
- Any other spec calling `authenticateVoter` or `goToAuthPage` → filling lot number

**New E2E scenario: OTP flow** (add to voter-journey spec or a dedicated `otp-auth.spec.ts`):
- Happy path: enter email → click Send → enter code → click Verify → reaches voting page
- Wrong code: enter email → click Send → enter wrong code → 401 error shown; code field cleared
- Resend: enter email → click Send → click Resend → new code sent → old code invalid → enter new code → success
- Expired code: seed an OTP row with `expires_at` in the past via test API; enter that code → 401 error

---

## 6. Security Considerations

| Concern | Mitigation |
|---|---|
| User enumeration via request-otp | Always return 200 from `request-otp` regardless of whether email is found |
| Code brute-force | 5-minute expiry + single-use + 60-second resend rate limit. 10^6 space with a 5-minute window and rate limiting means an attacker would need ~83,000 attempts/minute to have a 50% chance — impractical |
| Replay attack | `used = TRUE` after first successful verify; subsequent attempts get 401 |
| OTP leakage in logs | Never log the `code` value — log only `(email, meeting_id, expires_at)` |
| SMTP failure at request-otp | Return 500; do not expose SMTP error details to the client |
| Test endpoint in production | `GET /api/test/latest-otp` gated on `settings.testing_mode = False` by default; enabled only via `TESTING_MODE=true` env var |
| Accidental email to real customers in test env | `EMAIL_OVERRIDE=tocstesting@gmail.com` redirects all outgoing emails at the send layer; set on all branch/preview deployments |

---

## 7. Config / Environment Variables

The OTP email uses the existing SMTP config (`smtp_host`, `smtp_port`, `smtp_username`, `smtp_password`, `smtp_from_email`).

Add to `Settings`:

```python
testing_mode: bool = False          # Enables GET /api/test/latest-otp endpoint
email_override: str = ""            # If set, ALL outgoing emails are redirected to this address
```

**`email_override` behaviour:** Applied at the email-sending layer (not per-endpoint). When non-empty, every call to `send_email(to=..., ...)` replaces the `to` address with the override value before sending. This applies to OTP emails **and** all other system emails (e.g. meeting-close notifications). The original recipient is preserved in the email `X-Original-To` header for debugging.

**Vercel branch/preview deployments:** set both:
- `TESTING_MODE=true`
- `EMAIL_OVERRIDE=tocstesting@gmail.com`

**Production:** both unset (default `False` / `""`).

Add to `.env.example`:
```
TESTING_MODE=false
EMAIL_OVERRIDE=
```

---

## 8. Files Changed (summary)

### New files
- `backend/app/models/auth_otp.py`
- `backend/app/templates/otp_email.html`
- `backend/alembic/versions/<hash>_add_auth_otps_table.py`

### Modified files
- `backend/app/models/__init__.py` — add `AuthOtp`
- `backend/app/routers/auth.py` — add `request-otp` route; update `verify` to validate OTP
- `backend/app/schemas/auth.py` — add `OtpRequestBody`, `OtpRequestResponse`; update `AuthVerifyRequest` (add `code`)
- `backend/app/config.py` — add `testing_mode: bool = False`
- `frontend/src/components/vote/AuthForm.tsx` — two-step UI
- `frontend/src/pages/vote/AuthPage.tsx` — two mutations, updated callbacks
- `frontend/src/api/voter.ts` — add `requestOtp`, update `AuthVerifyRequest`
- `frontend/e2e/workflows/helpers.ts` — update `authenticateVoter`
- All E2E workflow specs that call `authenticateVoter`
