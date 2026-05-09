# Design: OTP Verification Method Toggle

PRD reference: `tasks/prd/prd-platform.md` — US-OTP-TOGGLE-01, US-OTP-TOGGLE-02, US-OTP-TOGGLE-03

**Status:** Implemented

---

## Overview

Admins need the ability to independently enable or disable each OTP verification channel (Email and SMS) from the Settings page. At least one channel must always remain active. When a voter authenticates, the frontend shows only the enabled channels; if only one channel is active, the channel-selector modal is skipped entirely and the code is sent automatically.

This feature touches:
- `tenant_config` DB table (new boolean columns)
- `TenantConfig` SQLAlchemy model
- Pydantic schemas for config GET/PUT
- `PUT /api/admin/config` and `GET /api/admin/config` endpoints
- `GET /api/config` public endpoint (voter-facing)
- `POST /api/auth/request-otp` enforcement logic
- Admin Settings page (UI & Theme tab, new Authentication subsection)
- Voter `AuthPage.tsx` channel-selector logic

---

## Database Changes

### Table: `tenant_config`

Add two boolean columns:

| Column | Type | Default | Notes |
|---|---|---|---|
| `otp_email_enabled` | `BOOLEAN NOT NULL DEFAULT TRUE` | `true` | Whether email OTP channel is available to voters |
| `otp_sms_enabled` | `BOOLEAN NOT NULL DEFAULT FALSE` | `false` | Whether SMS OTP channel is available to voters |

Default for `otp_sms_enabled` is `false` because SMS requires a separate SMS provider to be configured; enabling it by default on existing deployments would expose a broken channel.

Default for `otp_email_enabled` is `true` because email is the original and only channel; all existing deployments must continue working without any admin action.

No CHECK constraint is added at the DB level for the "at least one enabled" rule — this is enforced at the service layer so the error message is meaningful rather than a raw constraint violation.

### Alembic Migration

File: `backend/alembic/versions/<rev>_add_otp_channel_toggles.py`

Upgrade:
```sql
ALTER TABLE tenant_config
  ADD COLUMN otp_email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN otp_sms_enabled   BOOLEAN NOT NULL DEFAULT FALSE;
```

Downgrade:
```sql
ALTER TABLE tenant_config
  DROP COLUMN otp_email_enabled,
  DROP COLUMN otp_sms_enabled;
```

---

## Backend Changes

### SQLAlchemy Model — `backend/app/models/tenant_config.py`

Add two new mapped columns to `TenantConfig`:

```python
otp_email_enabled: Mapped[bool] = mapped_column(
    Boolean, nullable=False, default=True, server_default="true"
)
otp_sms_enabled: Mapped[bool] = mapped_column(
    Boolean, nullable=False, default=False, server_default="false"
)
```

### Pydantic Schemas — `backend/app/schemas/config.py`

**`TenantConfigOut`** — add fields so both admin and public endpoints return them:

```python
otp_email_enabled: bool = True
otp_sms_enabled: bool = False
```

The public endpoint (`GET /api/config`) already returns `TenantConfigOut`, so voters receive the enabled-channel list with no additional endpoint needed.

**`TenantConfigUpdate`** — add fields so `PUT /api/admin/config` can accept them:

```python
otp_email_enabled: bool = True
otp_sms_enabled: bool = False
```

Add a root validator that rejects a request where both are `False`:

```python
@model_validator(mode="after")
def at_least_one_channel(self) -> "TenantConfigUpdate":
    if not self.otp_email_enabled and not self.otp_sms_enabled:
        raise ValueError("At least one verification method must be enabled")
    return self
```

This gives a 422 response with a clear error message when the admin somehow bypasses the UI guard.

### Service — `backend/app/services/config_service.py`

`update_config()` must persist the two new fields:

```python
config.otp_email_enabled = data.otp_email_enabled
config.otp_sms_enabled = data.otp_sms_enabled
```

`get_config()` already returns the full model row; no additional logic needed.

### Router — `backend/app/routers/admin.py`

`GET /api/admin/config` and `PUT /api/admin/config` use `TenantConfigOut` and `TenantConfigUpdate` already. The only change is that `model_validate(config)` now includes the two new fields automatically.

### Public Endpoint — `backend/app/routers/public.py`

`GET /api/config` also uses `TenantConfigOut`. No code change needed; the new fields appear in the response automatically once the schema is updated.

### Auth Enforcement — `backend/app/routers/auth.py`

The `POST /api/auth/request-otp` handler is extended as follows:

After step 2 (rate limit check) and before the existing step 3 (email lookup), add:

1. Load `TenantConfig` via `config_service.get_config(db)` (already cached for 60s — no extra DB round-trip in the common case).
2. Compute `enabled_channels`: a list built from `["email"]` if `otp_email_enabled` and appending `"sms"` if `otp_sms_enabled AND sms_cfg.sms_enabled AND sms_cfg.sms_provider`.
3. If `body.channel` is supplied and not in `enabled_channels`, raise `HTTPException(503, "Requested verification method is not available")`.
4. The default channel for automatic sending (when `body.channel` is None) is `enabled_channels[0]` — always `"email"` unless only SMS is on.

The existing step 3b (SMS-channel validation) is superseded by the new `enabled_channels` check but the body-level `has_phone` check (`400` for no phone when SMS is requested) is retained.

**Edge case — SMS only, no phone:** If `enabled_channels == ["sms"]` and `has_phone is False`, return 400 with message `"SMS is the only verification method and no phone number is on file for your account"`. This is not enumeration-sensitive because the voter has already proved email knowledge by entering it; the absence of a phone is account-level information that is reasonable to reveal.

Include `enabled_channels` in the response.

### Pydantic Schema — `backend/app/schemas/auth.py`

**`OtpRequestResponse`** — add field:

```python
enabled_channels: list[str] = ["email"]
```

---

## Frontend Changes

### TypeScript API — `frontend/src/api/config.ts`

Add `otp_email_enabled: boolean` and `otp_sms_enabled: boolean` to the `TenantConfig` interface.

### TypeScript API — `frontend/src/api/voter.ts`

Add `enabled_channels: string[]` to the response interface for `requestOtp`.

### Admin Settings Page — `frontend/src/pages/admin/SettingsPage.tsx`

**Location in UI:** Inside the "UI & Theme" tab, below the Support email field, add a new subsection titled "Authentication methods".

**New state:**
```typescript
const [otpEmailEnabled, setOtpEmailEnabled] = useState(true);
const [otpSmsEnabled, setOtpSmsEnabled] = useState(false);
const [otpMethodError, setOtpMethodError] = useState("");
const [pendingDisableMethod, setPendingDisableMethod] = useState<"email" | "sms" | null>(null);
```

**Load:** Extend the existing `useEffect` that calls `getAdminConfig()` to also initialise the two new state values.

**Toggle handler logic:**

```
handleOtpMethodToggle(method: "email" | "sms", checked: boolean):
  if checked:
    setOtpMethodError("")
    apply toggle immediately
  else:
    otherEnabled = (method === "email") ? otpSmsEnabled : otpEmailEnabled
    if !otherEnabled:
      setOtpMethodError("At least one verification method must be enabled")
    else:
      setOtpMethodError("")
      setPendingDisableMethod(method)   // show confirmation dialog; do NOT change toggle yet
```

**Confirmation dialog confirms and cancels:** On confirm, apply the toggle change and clear `pendingDisableMethod`. On cancel, leave toggle unchanged and clear `pendingDisableMethod`.

**Save flow guard:** In `handleSubmit`, before the API call, if both toggles are off, set `otpMethodError` and abort. This is a second line of defence after the dialog guard.

**UI structure (Authentication subsection):**

```tsx
<div style={{ marginTop: 24 }}>
  <p className="field__label" style={{ marginBottom: 8 }}>Authentication methods</p>

  <div className="field" style={{ marginBottom: 12 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={otpEmailEnabled}
        onChange={(e) => handleOtpMethodToggle("email", e.target.checked)}
        aria-label="Enable email OTP verification"
      />
      <span>Email verification</span>
    </label>
  </div>

  <div className="field" style={{ marginBottom: 0 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={otpSmsEnabled}
        onChange={(e) => handleOtpMethodToggle("sms", e.target.checked)}
        aria-label="Enable SMS OTP verification"
      />
      <span>SMS verification</span>
    </label>
  </div>

  {otpMethodError && (
    <span className="field__error" role="alert">{otpMethodError}</span>
  )}
</div>
```

**Confirmation dialog** uses the existing `.dialog-overlay` / `.dialog` / `.dialog__body` / `.dialog__actions` pattern from SettingsPage:

- Title: "Disable email verification?" or "Disable SMS verification?"
- Body: warning text as specified in US-OTP-TOGGLE-01 / US-OTP-TOGGLE-02
- Actions: Cancel (`.btn--ghost`) and Disable (`.btn--danger`)

### Voter Auth Page — `frontend/src/pages/vote/AuthPage.tsx`

`ChannelModal` gets a new prop `enabledChannels: string[]`. Inside the component, each radio is only rendered if its value is in `enabledChannels`.

In `AuthPage`, the `requestOtpMutation.onSuccess` first-call branch is updated:

```typescript
if (variables.otpChannel === undefined) {
  const enabledChannels = data.enabled_channels ?? ["email"];
  const multiChannel = enabledChannels.length > 1;

  if (multiChannel && data.has_phone) {
    setPhoneHint(data.phone_hint ?? null);
    setChannel("email");
    setShowChannelModal(true);
  } else {
    // Single channel or voter has no phone: OTP already sent, go straight to code entry
    setPhoneHint(data.phone_hint ?? null);
    setAuthStep("code");
  }
}
```

Store `enabledChannels` in component state so it can be passed to `ChannelModal`:

```typescript
const [enabledChannels, setEnabledChannels] = useState<string[]>(["email"]);
```

Set it on first-call success: `setEnabledChannels(data.enabled_channels ?? ["email"])`.

Pass it to `ChannelModal`: `<ChannelModal ... enabledChannels={enabledChannels} />`.

### MSW Mock Handlers — `frontend/tests/msw/handlers.ts`

- `GET /api/admin/config` mock response: add `otp_email_enabled: true, otp_sms_enabled: false`
- `PUT /api/admin/config` mock response: echo back the same new fields
- `GET /api/config` (public) mock response: add `otp_email_enabled: true, otp_sms_enabled: false`
- `POST /api/auth/request-otp` mock response: add `enabled_channels: ["email"]` (or `["email", "sms"]` in tests that need SMS)

---

## Key Design Decisions

1. **New columns in `tenant_config`, not `tenant_smtp_config`:** The OTP channel toggles are conceptually tenant auth behaviour, not SMTP/SMS infrastructure. `tenant_config` is the home for auth-adjacent settings. Splitting across two singleton tables would create unnecessary coupling.

2. **`otp_sms_enabled` defaults to `false`:** Existing deployments without SMS configured must not suddenly expose a broken channel. Opt-in is safer than opt-out for a feature that can lock out voters.

3. **`enabled_channels` in `OtpRequestResponse`:** The voter page needs the channel list at the moment of the first OTP request (after email entry), not on page load. Embedding it in the OTP response keeps the flow synchronous. The public config endpoint also exposes the toggles for early UX decisions (e.g. skipping the phone hint label when SMS is disabled).

4. **Backend enforces the disabled-channel check in `request-otp`:** A client sending `channel=sms` when SMS is admin-disabled receives 503. This prevents a stale frontend from using a method the admin disabled after the voter loaded the page.

5. **`config_service.get_config` is already cached for 60s:** Loading the config inside `request-otp` adds zero latency in the common case. A toggle change takes effect within 60 seconds for new OTP requests.

6. **Confirmation dialog is pre-save:** The admin sees the warning before the toggle is applied. The toggle state in React does not change until the admin confirms. This prevents accidental lockouts and matches the "Remove user" confirmation pattern used elsewhere on the same page.

7. **At-least-one enforced both client-side and server-side:** Client-side gives immediate UX feedback. The `model_validator` in `TenantConfigUpdate` provides a defence-in-depth 422.

---

## Data Flow — Happy Path

### Admin sets SMS-only

1. Admin opens Settings → UI & Theme tab.
2. `GET /api/admin/config` response includes `otp_email_enabled: true, otp_sms_enabled: false`.
3. Admin checks "SMS verification" → applied immediately (enabling, no dialog).
4. Admin unchecks "Email verification" → confirmation dialog shown.
5. Admin clicks "Disable" → `otpEmailEnabled = false`.
6. Admin clicks Save → `PUT /api/admin/config` with `otp_email_enabled: false, otp_sms_enabled: true`.
7. Cache invalidated; success message shown.

### Voter logs in (SMS-only tenant)

1. Voter enters email, clicks "Send Verification Code".
2. `POST /api/auth/request-otp` with no channel.
3. Backend: `enabled_channels = ["sms"]`; voter has phone → OTP sent via SMS; response: `{ sent: true, has_phone: true, phone_hint: "...", enabled_channels: ["sms"] }`.
4. Frontend: `multiChannel = false` → skip modal, set `authStep = "code"`.
5. Voter enters code, verifies normally.

---

## Security Considerations

| Concern | Mitigation |
|---|---|
| Admin disables all channels via direct API call | `model_validator` in `TenantConfigUpdate` returns 422 if both are false |
| Voter forces a disabled channel | Backend checks `enabled_channels` before sending OTP; returns 503 |
| Enumeration — "no phone + SMS-only" error | Acceptable: voter has proven email ownership; phone absence is not sensitive here |
| Cache lag after admin toggles channel | 60s TTL; worst case is OTP sent via a newly-disabled channel within 1 minute of admin change, which is an acceptable window |

---

## Files to Change

| File | Change |
|---|---|
| `backend/alembic/versions/<rev>_add_otp_channel_toggles.py` | New migration: add `otp_email_enabled`, `otp_sms_enabled` columns to `tenant_config` |
| `backend/app/models/tenant_config.py` | Add `otp_email_enabled`, `otp_sms_enabled` mapped columns with Boolean type |
| `backend/app/schemas/config.py` | Add fields to `TenantConfigOut` and `TenantConfigUpdate`; add `model_validator` for at-least-one |
| `backend/app/schemas/auth.py` | Add `enabled_channels: list[str]` to `OtpRequestResponse` |
| `backend/app/services/config_service.py` | Persist new fields in `update_config()`; include defaults in seed-row creation |
| `backend/app/routers/auth.py` | Load config, compute `enabled_channels`, enforce disabled-channel check, return in response |
| `frontend/src/api/config.ts` | Add `otp_email_enabled: boolean`, `otp_sms_enabled: boolean` to `TenantConfig` interface |
| `frontend/src/api/voter.ts` | Add `enabled_channels: string[]` to OTP request response type |
| `frontend/src/pages/admin/SettingsPage.tsx` | Authentication subsection with two checkboxes, confirmation dialog, updated save payload |
| `frontend/src/pages/vote/AuthPage.tsx` | Updated first-call onSuccess logic; `enabledChannels` state; pass to `ChannelModal`; filter modal radios |
| `frontend/tests/msw/handlers.ts` | Update admin config, public config, and request-otp mock responses with new fields |

---

## Test Cases

### Backend — Unit Tests (mocked DB)

| Test | Expected |
|---|---|
| `TenantConfigUpdate` with both toggles false | 422 with "At least one verification method must be enabled" |
| `TenantConfigUpdate` email=true, sms=false | Passes validation |
| `TenantConfigUpdate` email=false, sms=true | Passes validation |
| `update_config` persists `otp_email_enabled=false` | Returned object has `otp_email_enabled=False` |
| `get_config` default values for new columns | `otp_email_enabled=True, otp_sms_enabled=False` |
| `request-otp` with `channel=email` when `otp_email_enabled=False` | 503 |
| `request-otp` with `channel=sms` when `otp_sms_enabled=False` | 503 |
| `request-otp` no channel, only SMS enabled, voter has phone | OTP sent via SMS; `enabled_channels=["sms"]` in response |
| `request-otp` no channel, only SMS enabled, voter has no phone | 400 with lockout message |
| `request-otp` no channel, both enabled, voter has no phone | OTP sent via email; `enabled_channels=["email","sms"]` |
| `request-otp` no channel, both enabled, voter has phone | OTP sent via email (first call); `enabled_channels=["email","sms"]` |

### Backend — Integration Tests (real test DB)

| Test | Expected |
|---|---|
| Migration applies to clean test DB | `tenant_config` has both new columns |
| `PUT /api/admin/config` with new fields | `GET /api/admin/config` returns updated values |
| `GET /api/config` public returns new fields | `otp_email_enabled: true, otp_sms_enabled: false` on fresh DB |
| `POST /api/auth/request-otp` when email disabled and email channel requested | 503 |

### Frontend — Unit Tests (Vitest + RTL)

| Test | Expected |
|---|---|
| SettingsPage: toggle email OFF when SMS also OFF | Inline error shown; toggle not applied |
| SettingsPage: toggle email OFF when SMS ON | Confirmation dialog shown with email warning text |
| SettingsPage: confirm disable email | Toggle applied; dialog dismissed |
| SettingsPage: cancel disable email dialog | Toggle unchanged; dialog dismissed |
| SettingsPage: toggle SMS ON | Applied immediately; no dialog |
| SettingsPage: save sends `otp_email_enabled`, `otp_sms_enabled` in payload | API called with correct values |
| AuthPage: `enabled_channels=["email"]` + has_phone | No channel modal; code step shown |
| AuthPage: `enabled_channels=["sms"]` + has_phone | No channel modal; code step shown |
| AuthPage: `enabled_channels=["email","sms"]` + has_phone | Channel modal shown |
| AuthPage: `enabled_channels=["email","sms"]` + no phone | No modal; code step shown |
| ChannelModal: `enabledChannels=["email"]` | Only email radio rendered |
| ChannelModal: `enabledChannels=["sms"]` | Only SMS radio rendered |
| ChannelModal: `enabledChannels=["email","sms"]` | Both radios rendered |

---

## E2E Test Scenarios

### Happy path — both channels enabled, voter with phone

1. Seed: building + meeting + lot owner with phone; config defaults (email ON, SMS OFF).
2. Voter enters email, submits.
3. Assert: channel modal does NOT appear (SMS off → single channel).
4. Voter enters OTP code, verifies.
5. Assert: reaches voting page.

### Happy path — SMS-only tenant, voter with phone

1. Seed: building + meeting + lot owner with phone; config `otp_email_enabled=false, otp_sms_enabled=true` (sms provider configured).
2. Voter enters email, submits.
3. Assert: channel modal does NOT appear.
4. Assert: code entry step shown.
5. Voter enters OTP code (retrieved via test endpoint), verifies.
6. Assert: reaches voting page.

### Error path — SMS-only tenant, voter with no phone

1. Seed: building + meeting + lot owner with no phone; config `otp_email_enabled=false, otp_sms_enabled=true`.
2. Voter enters email, submits.
3. Assert: error message "SMS is the only verification method and no phone number is on file".
4. Assert: voter remains on auth page.

### Admin disables email with confirmation dialog

1. Admin logs in, navigates to Settings → UI & Theme tab.
2. SMS toggle is checked.
3. Uncheck "Email verification".
4. Assert: confirmation dialog with email warning text appears.
5. Click "Disable".
6. Assert: dialog closed; Email toggle unchecked.
7. Click "Save".
8. Assert: success message shown; `GET /api/admin/config` returns `otp_email_enabled: false`.

### Admin cannot disable last method

1. Admin logs in, Settings → UI & Theme tab.
2. Email ON, SMS OFF.
3. Uncheck "Email verification".
4. Assert: inline error "At least one verification method must be enabled"; no dialog appears; email toggle remains checked.

### Multi-step sequence: SMS-only lockout and recovery

1. Seed: meeting with voterA (has phone) and voterB (no phone).
2. Admin sets `otp_email_enabled=false, otp_sms_enabled=true`.
3. voterA authenticates via SMS (no modal) → submits vote.
4. voterB attempts to authenticate → sees lockout error.
5. Admin re-enables email (`otp_email_enabled=true`).
6. voterB authenticates via email (no modal, single channel) → submits vote.
7. Assert: both votes recorded.

### Existing E2E specs affected

The following existing specs exercise the voter auth flow and must have their MSW mock responses for `POST /api/auth/request-otp` updated to include `enabled_channels: ["email"]`:

- `e2e_tests/voting-flow.spec.ts`
- `e2e_tests/multi-lot-voting.spec.ts`
- `e2e_tests/proxy-voting.spec.ts`
- All specs under `e2e_tests/workflows/` that call `authenticateVoter`

The change is additive (new field in response) and the default `["email"]` value preserves existing single-channel behaviour, so no test logic changes are required — only the mock handler update.

---

## Schema Migration Required

Yes — adds `otp_email_enabled` (default `true`) and `otp_sms_enabled` (default `false`) columns to the `tenant_config` table. All existing rows receive their default values automatically; no data backfill script is needed.
