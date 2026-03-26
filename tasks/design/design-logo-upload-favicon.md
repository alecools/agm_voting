# Design: Logo Upload + Dynamic Favicon

## Overview

Add a logo file upload capability to the admin Settings page so the admin can upload an image directly rather than pasting a URL. The uploaded file is stored in Vercel Blob and the resulting public URL is saved to `tenant_config.logo_url` via the existing `PUT /api/admin/config` endpoint. Additionally, the favicon is driven dynamically from `logo_url` (set in `BrandingContext` on every config load), and the static logo asset files are removed.

**Schema migration needed: NO** — `tenant_config.logo_url` already exists as a `VARCHAR` column. No schema changes are required.

---

## Database changes

None. `tenant_config.logo_url` is already a nullable/optional varchar column. The upload only changes where the URL value comes from (Vercel Blob CDN) rather than a user-typed URL.

---

## Backend changes

### New dependency: `httpx`

Vercel Blob does not have a native Python SDK. The upload is performed by calling the Vercel Blob REST API directly over HTTPS using `httpx` (async). `httpx` is already present as a dev dependency; it must be added as a runtime dependency in `pyproject.toml`.

### New module: `backend/app/services/blob_service.py`

```python
async def upload_to_blob(filename: str, content: bytes, content_type: str) -> str:
    """Upload bytes to Vercel Blob and return the public URL.

    Uses the Vercel Blob REST API (PUT /api/blob/upload).
    Requires BLOB_READ_WRITE_TOKEN env var.
    Raises HTTPException(500) if token is missing.
    Raises HTTPException(502) if the upload fails.
    """
```

The function:
1. Reads `BLOB_READ_WRITE_TOKEN` from env (`os.environ`). If missing, raises `HTTPException(500, "Blob storage not configured")`.
2. Issues an async `PUT` request to `https://blob.vercel-storage.com/{filename}` with headers:
   - `Authorization: Bearer {token}`
   - `x-content-type: {content_type}`
   - `x-add-random-suffix: 1`
   - body = raw bytes
3. Parses the JSON response and returns `response["url"]`.
4. On non-2xx response: raises `HTTPException(502, "Logo upload failed")`.

### New endpoint: `POST /api/admin/config/logo`

Added to `backend/app/routers/admin.py`:

```
POST /api/admin/config/logo
Content-Type: multipart/form-data
Body: file (UploadFile, required)
Auth: require_admin

Response 200: { "url": "https://public.blob.vercel-storage.com/logo-abc123.png" }
Response 400: file too large (>5 MB) or missing file
Response 415: unsupported file type
Response 500: BLOB_READ_WRITE_TOKEN not configured
Response 502: upstream Vercel Blob upload failed
```

Implementation notes:
- Accepted MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml`
- Accepted extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`
- Detection logic: extension takes precedence over content-type (same pattern as `_detect_file_format`)
- Max size: 5 MB (5 * 1024 * 1024 bytes), enforced after `await file.read()`
- The endpoint does NOT update `tenant_config` — it only uploads and returns the URL. The frontend then sends the URL via the existing `PUT /api/admin/config`.

### New Pydantic schema: `LogoUploadOut`

Added to `backend/app/schemas/config.py`:

```python
class LogoUploadOut(BaseModel):
    url: str
```

### Environment variable

`BLOB_READ_WRITE_TOKEN` — must be set in Vercel project env vars for production and preview. Not needed for unit/integration tests (blob service is mocked).

---

## Frontend changes

### 1. `apiFetch` check

Inspect `frontend/src/api/client.ts` before implementation. The `uploadLogo` function passes a `FormData` body — `apiFetch` must NOT set `Content-Type: application/json` when the body is `FormData`. If it currently forces that header unconditionally, add a guard: only set `Content-Type: application/json` when `body` is a string (i.e. `JSON.stringify(...)` output).

### 2. New API client function: `uploadLogo`

Added to `frontend/src/api/config.ts`:

```typescript
export async function uploadLogo(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<{ url: string }>("/api/admin/config/logo", {
    method: "POST",
    body: formData,
  });
}
```

### 3. Updated `SettingsPage.tsx`

New state:
- `isUploading: boolean` — true while `uploadLogo` is in flight
- `uploadError: string` — error message from a failed upload

New handler `handleLogoFileChange`:
1. Set `isUploading = true`, clear `uploadError`
2. Call `uploadLogo(file)`
3. On success: set `logoUrl` state to the returned URL
4. On error: set `uploadError` to the error message
5. Set `isUploading = false`

New UI added below the existing "Logo URL" text field:

```tsx
<div className="field">
  <label className="field__label" htmlFor="logo-file">Upload logo image</label>
  <input
    id="logo-file"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
    onChange={handleLogoFileChange}
    disabled={isUploading}
    data-testid="logo-file-input"
  />
  {isUploading && <p className="state-message">Uploading…</p>}
  {uploadError && <span className="field__error">{uploadError}</span>}
</div>
```

Note: `<input type="file">` does not use `field__input` class — file inputs have native browser chrome that overrides CSS styling and using `field__input` would cause visual inconsistency. The `field` wrapper and `field__label` are still used for layout consistency.

The existing "Save" flow is unchanged. Saving the config form calls `updateAdminConfig` with `logo_url` equal to whatever is currently in `logoUrl` state (whether typed or populated by upload).

### 4. Updated `BrandingContext.tsx`

In the existing `useEffect`, add favicon update after the existing CSS variable and title updates:

```typescript
useEffect(() => {
  if (data) {
    document.documentElement.style.setProperty("--color-primary", data.primary_colour);
    document.title = data.app_name;
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (link) {
      link.href = data.logo_url || "/favicon.ico";
    }
  }
}, [data]);
```

### 5. Updated `frontend/index.html`

Change the existing favicon link from:
```html
<link rel="icon" type="image/png" href="/logo.png" />
```
To:
```html
<link rel="icon" href="/favicon.ico" />
```

This removes the hardcoded `logo.png` reference while keeping a `<link rel="icon">` tag in the DOM for JS to update. The fallback `/favicon.ico` is intentional — when no logo is configured, the browser shows its default tab icon (the 404 is silent and acceptable).

### 6. Delete static assets

- `frontend/public/logo.png`
- `frontend/public/logo.webp`

Use `git rm` so the deletions are staged.

---

## Key design decisions

1. **Upload then save (two-step)** — The logo upload returns a URL, which is then embedded in the normal config save. This avoids complicating the `PUT /api/admin/config` endpoint and keeps the config schema unchanged.

2. **Backend-mediated upload** — `BLOB_READ_WRITE_TOKEN` stays server-side. Client-side direct upload (with a server-issued token) adds complexity without meaningful UX benefit for an admin-only feature.

3. **No Alembic migration** — `logo_url` already exists.

4. **Keep URL text input alongside file upload** — Admins who already have a CDN URL retain the ability to paste it directly. Both inputs write to the same `logoUrl` state.

5. **Favicon fallback to `/favicon.ico`** — When `logo_url` is empty, the href is set to `/favicon.ico`. A 404 on that URL results in the browser's default tab icon, which is preferable to showing a stale logo.

---

## Data flow (happy path — file upload)

1. Admin opens Settings page → `GET /api/admin/config` loads current config
2. Admin selects a `.png` file via the file input
3. `onChange` → `uploadLogo(file)` → `POST /api/admin/config/logo` (multipart)
4. Backend: validates size and MIME, calls `blob_service.upload_to_blob`
5. `blob_service`: `PUT https://blob.vercel-storage.com/{filename}` with bearer token
6. Vercel Blob returns `{ url: "https://public.blob.vercel-storage.com/..." }`
7. Backend returns `{ "url": "..." }` to frontend
8. Frontend: `logoUrl` state updated with the Blob URL
9. Admin clicks "Save" → `PUT /api/admin/config` with new `logo_url`
10. `BrandingContext` cache invalidated → re-fetch → `useEffect` sets `link[rel='icon'].href`

---

## E2E Test Scenarios

File: `frontend/e2e/admin/admin-settings.spec.ts` — update existing spec, do not create a parallel file.

### Happy path
1. Admin navigates to Settings page — both "Logo URL" text input and "Upload logo image" file input are visible
2. Admin uploads a valid PNG file — "Uploading…" message appears, then URL text input is populated with the Blob URL
3. Admin clicks Save — "Settings saved." appears
4. Verify `link[rel='icon']` href in the document head equals the logo URL

### Upload error cases
5. Admin uploads a non-image file — upload error message appears, URL input unchanged
6. Server returns 502 on upload — error message displayed

### Favicon
7. On page load with `logo_url` set — `link[rel='icon']` href equals the logo URL
8. On page load with empty `logo_url` — `link[rel='icon']` href is `/favicon.ico`

### Static asset removal
9. Smoke test: verify `GET /logo.png` returns 404 (file no longer served)

---

## Vertical slice decomposition

Single slice — backend upload endpoint, frontend file input, and favicon update are tightly coupled. No split needed.

**Schema migration needed: NO**
