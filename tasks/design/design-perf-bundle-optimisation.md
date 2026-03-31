# Design: Performance — Bundle Optimisation + Serving Infrastructure

**Status:** Implemented

## Overview

The voter-facing JS payload is larger than necessary and static assets are routed through the FastAPI Lambda rather than being served from Vercel's CDN edge. This design covers five independent improvements:

1. Remove `xlsx` from the voter bundle by moving client-side Excel parsing to a lazy-loaded admin-only module
2. Fix the catch-all rewrite in `vercel.json` so `dist/assets/` files are served from Vercel CDN
3. Add `Cache-Control: immutable` headers for Vite-hashed asset files
4. Convert `logo.png` (201 KB) to WebP
5. Pre-generate Brotli-compressed bundles at build time

None of these items touch the database or require an Alembic migration.

---

## Background: What `xlsx` is actually used for

`xlsx` (SheetJS) appears in the frontend only as a **client-side parser** — not as a download generator. The sole consumer is `frontend/src/utils/parseMotionsExcel.ts`, which calls `XLSX.read(buffer)` and `XLSX.utils.sheet_to_json()` when an admin uploads a motions CSV/Excel file via `MotionExcelUpload.tsx`.

No other component imports `xlsx`. The four other upload components (BuildingCSVUpload, LotOwnerCSVUpload, FinancialPositionUpload, ProxyNominationsUpload) all POST the raw file directly to the backend API — the browser never parses them.

The motion parsing **cannot trivially move server-side** without also changing the admin flow (the parsed motions are fed into a React form for editing before saving). The correct fix is therefore to keep the parsing client-side but ensure `xlsx` is only bundled into the admin chunk, never into the voter chunk.

---

## 1. Remove `xlsx` from the voter bundle

### Problem

`xlsx` is ~750 KB minified / ~200 KB gzipped. It lands in whatever chunk imports `parseMotionsExcel.ts`, which is currently included in the default `vendor` chunk or the main app chunk. Any voter who loads the app downloads this library even though they never use it.

### Solution: Dynamic import with Rollup manual chunk isolation

Two changes are needed:

**a) `frontend/src/components/admin/MotionExcelUpload.tsx`**

Replace the static import of `parseMotionsExcel` with a dynamic import so Rollup can tree-shake and split it into a separate chunk:

```ts
// Before (static — xlsx ends up in the bundle evaluated on voter load)
import { parseMotionsExcel } from "../../utils/parseMotionsExcel";

// After (dynamic — chunk is only fetched when the admin upload component mounts)
const { parseMotionsExcel } = await import("../../utils/parseMotionsExcel");
```

The call site is already inside an async `handleChange` function, so the `await` fits naturally.

**b) `frontend/vite.config.ts`**

Add `xlsx` to `manualChunks` so Rollup puts it in a dedicated chunk that is never referenced by voter routes:

```ts
manualChunks: {
  vendor: ["react", "react-dom", "react-router-dom"],
  xlsx: ["xlsx"],
},
```

With the dynamic import in place, Rollup will not reference the `xlsx` chunk from any voter entry point. The chunk is fetched lazily only when an admin actually opens the motion upload component.

### Expected outcome

| Metric | Before | After (estimate) |
|---|---|---|
| Initial JS transferred to voters | ~350 KB gzipped | ~150 KB gzipped |
| `xlsx` chunk | bundled in main | ~200 KB gzipped, lazy admin-only |

### Files changed

- `frontend/src/components/admin/MotionExcelUpload.tsx` — dynamic import
- `frontend/vite.config.ts` — `manualChunks` addition

### Test impact

- `frontend/src/components/admin/__tests__/MotionExcelUpload.test.tsx` — the dynamic import must be mocked via `vi.mock("../../utils/parseMotionsExcel", ...)`. Existing MSW-based tests of the component continue to work; only the import style changes.
- `frontend/src/utils/__tests__/parseMotionsExcel.test.ts` — no changes needed (the utility itself is unchanged).

---

## 2. Fix static assets bypassing Vercel CDN

### Problem

`vercel.json` currently contains a single catch-all rewrite:

```json
{ "source": "/(.*)", "destination": "/api/index" }
```

This matches `/assets/index-abc123.js`, `/assets/vendor-xyz.css`, and `/logo.png`, routing all of them through the FastAPI Lambda. Consequences:

- Every JS/CSS request incurs Lambda cold start and execution time
- Assets are not cached at the CDN edge
- Vercel's smart CDN bypassing (the built-in static file serving layer) is disabled

### Solution

Vercel's routing pipeline evaluates routes in this order: `headers` → `redirects` → `rewrites`. By adding explicit `headers` and placing the rewrite last (unchanged), static files served from `frontend/dist/` are matched by Vercel's implicit static file handler before the rewrite fires.

However, Vercel's static serving only applies to files present in the deployment output. The `buildCommand` copies `frontend/dist/` into `api/static/`, but Vercel must be told to also treat `frontend/dist/` as a static output directory. This is done via `outputDirectory` in `vercel.json`:

```json
{
  "outputDirectory": "frontend/dist",
  "buildCommand": "cd frontend && npm install && npx vite build && cp -r dist ../api/static && bash ../scripts/migrate.sh",
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    }
  ],
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index" },
    { "source": "/((?!assets/).*)", "destination": "/api/index" }
  ]
}
```

Key points:

- `outputDirectory: "frontend/dist"` tells Vercel to serve files from the Vite build output at the CDN edge. Any request whose path matches a file in `dist/` is served directly without hitting the Lambda.
- The `/api/(.*)` rewrite explicitly routes API calls to the Lambda.
- The negative lookahead `/((?!assets/).*)` ensures that `/assets/` paths that do not match a static file still fall through to the Lambda (defensive; in practice they will always match a static file).
- HTML5 pushState routes (e.g. `/vote/123/voting`) do not match any static file and continue to fall through to `/api/index` which serves `index.html`.

### Files changed

- `vercel.json`

---

## 3. Immutable cache headers for Vite assets

### Problem

Vite content-hashes all filenames under `dist/assets/` (e.g. `index-3f8a2c.js`). These hashes change only when the content changes. Browsers and CDNs can safely cache them forever, but without explicit `Cache-Control` headers they are served with short or no cache lifetimes.

### Solution

The `headers` block added in item 2 already covers this:

```json
{
  "source": "/assets/(.*)",
  "headers": [
    { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
  ]
}
```

`max-age=31536000` = 1 year. `immutable` tells browsers the file will never change at this URL, suppressing conditional revalidation requests.

`logo.webp` (and other non-hashed public assets) should NOT receive `immutable` since their URL does not change between deployments. They can receive a shorter `max-age` (e.g. 3600) if desired, but that is out of scope for this slice.

### Files changed

- `vercel.json` (already covered by item 2 above — same header block)

---

## 4. Convert logo.png to WebP

### Problem

`frontend/public/logo.png` is 201 KB. WebP achieves 25–50% smaller file sizes than PNG for photographic/complex images with no perceptible quality loss.

### Solution

**Build-time conversion** (not a runtime step):

The implementor converts `logo.png` to `logo.webp` using `cwebp` or an equivalent tool at quality 85:

```bash
cwebp -q 85 frontend/public/logo.png -o frontend/public/logo.webp
```

Expected size: ~50–80 KB (60–75% reduction).

The original `logo.png` is **kept** alongside `logo.webp` as a fallback for browsers that do not support WebP (Safari <14, IE). The HTML references are updated to use a `<picture>` element:

```tsx
// Before
<img src="/logo.png" alt="General Meeting Vote" className="app-header__logo" />

// After
<picture>
  <source srcSet="/logo.webp" type="image/webp" />
  <img src="/logo.png" alt="General Meeting Vote" className="app-header__logo" />
</picture>
```

### Files changed (4 component files)

All four references to `/logo.png`:

- `frontend/src/components/vote/VoterShell.tsx` (line 7)
- `frontend/src/pages/admin/AdminLoginPage.tsx` (line 33)
- `frontend/src/pages/admin/AdminLayout.tsx` (line 60 — desktop sidebar)
- `frontend/src/pages/admin/AdminLayout.tsx` (line 88 — mobile header)

New file added:

- `frontend/public/logo.webp` (generated from `logo.png`, not committed as source — the build step generates it, or it is committed as a binary asset alongside the PNG)

### Test impact

- Unit tests that render `VoterShell`, `AdminLoginPage`, or `AdminLayout` and assert on the logo `<img>` must be updated to query inside the `<picture>` wrapper. Tests asserting `getByRole("img", { name: "General Meeting Vote" })` continue to work because the `<img>` inside `<picture>` still carries the `alt` attribute.
- No backend tests affected.

---

## 5. Brotli pre-compression

### Problem

Vercel CDN supports Brotli decompression, but only serves pre-compressed `.br` files if they are present in the deployment output. Without them, the CDN falls back to gzip (or no compression). Brotli achieves ~15–20% better compression than gzip at equivalent quality.

### Solution

Add `vite-plugin-compression` to the Vite build. This plugin generates `.br` (and optionally `.gz`) files alongside every output file during `vite build`.

**`frontend/vite.config.ts`:**

```ts
import compression from "vite-plugin-compression";

export default defineConfig({
  plugins: [
    react(),
    compression({ algorithm: "brotliCompress", ext: ".br" }),
  ],
  // ... rest unchanged
});
```

**`frontend/package.json`** — add to `devDependencies`:

```json
"vite-plugin-compression": "^0.5.1"
```

**`vercel.json`** — add a header to signal the encoding for pre-compressed files. Vercel's CDN automatically serves `.br` files when the client sends `Accept-Encoding: br` and a matching `.br` file exists in the output. No additional header configuration is required beyond what Vercel handles automatically. However, the `Content-Encoding` header must be set for Vercel to recognise pre-compressed assets:

```json
{
  "source": "/assets/(.*)\\.br",
  "headers": [
    { "key": "Content-Encoding", "value": "br" },
    { "key": "Content-Type", "value": "application/javascript" }
  ]
}
```

Note: Vercel's automatic Brotli serving of pre-compressed files requires the `.br` extension convention. The above header entry ensures the Lambda does not accidentally serve the `.br` file as raw binary when the CDN routing misses.

### Files changed

- `frontend/package.json` — add `vite-plugin-compression` to devDependencies
- `frontend/vite.config.ts` — add compression plugin
- `vercel.json` — add Content-Encoding header for `.br` assets

---

## Key Design Decisions

**Why dynamic import rather than moving xlsx server-side?**
The motion Excel upload feeds parsed motions into an editable React form before saving. Moving parsing to the server would require a new API endpoint that returns structured `MotionFormEntry[]`, a loading state in the UI, and new tests at both levels. The dynamic import achieves zero xlsx in the voter bundle with minimal code change and no new API surface.

**Why keep `logo.png` alongside `logo.webp`?**
Safari gained WebP support in version 14 (September 2020). The user base likely contains older iPads at AGMs. The `<picture>` fallback pattern is the standard approach and costs nothing at runtime.

**Why `outputDirectory: "frontend/dist"` rather than a more complex Vercel config?**
Vercel's static serving pipeline is opt-in via `outputDirectory`. Setting it to `frontend/dist` is the minimal change that enables CDN-edge serving of all Vite-built files without restructuring the project.

---

## Data Flow (happy path — voter page load after fix)

1. Browser requests `https://agm-voting.vercel.app/`
2. Vercel CDN: path `/` does not match any file in `frontend/dist/` → rewrite fires → Lambda returns `index.html`
3. Browser parses `index.html`, requests `/assets/index-abc123.js` and `/assets/vendor-xyz.js`
4. Vercel CDN: paths match files in `frontend/dist/assets/` → served directly from CDN edge with `Cache-Control: public, max-age=31536000, immutable` and `Content-Encoding: br`
5. No Lambda invocation for asset requests
6. `xlsx` chunk is NOT requested at this point (dynamic import, admin-only)
7. Admin navigates to motion upload → React lazy-loads `parseMotionsExcel` chunk → `xlsx` chunk fetched from CDN edge (also immutably cached after first load)

---

## Schema Migration Note

No database changes. Schema migration required: **no**.

---

## E2E Test Scenarios

### Happy path

**VP-PERF-01: Voter assets served from CDN (not Lambda)**
- Load the voter app in a real browser
- Open DevTools Network tab
- Assert that requests to `/assets/*.js` return HTTP 200 with `Cache-Control: public, max-age=31536000, immutable` response header
- Assert `Content-Encoding: br` is present (Brotli served)
- Assert no `/assets/` request shows a Lambda cold-start delay (response time < 200 ms on second load)

**VP-PERF-02: `xlsx` chunk is not loaded for voters**
- Load the voter app and complete the full voter journey (building select → auth → vote → submit)
- Open DevTools Network tab
- Assert no request to any chunk containing `xlsx` in the filename is made during the voter journey

**VP-PERF-03: Admin motion upload still works after dynamic import**
- Log in to admin portal
- Navigate to a meeting's motion editor
- Click "Import motions from CSV or Excel"
- Upload `examples/AGM Motion test.xlsx`
- Assert motions are populated in the form correctly (same behaviour as before)
- Assert that the `xlsx` chunk is fetched from the network only at this point

**VP-PERF-04: Logo rendered correctly in all app locations**
- Load voter shell — assert logo image is visible with alt text "General Meeting Vote"
- Load admin login page — assert logo image is visible
- Load admin layout (sidebar) — assert logo image is visible
- In a WebP-supporting browser: assert the `<source type="image/webp">` element is present in DOM

### Error/edge cases

**VP-PERF-05: Fallback PNG served to non-WebP browsers**
- Simulate a non-WebP browser (or test the `<picture>` fallback structure in a unit test)
- Assert the `<img src="/logo.png">` element is present as the fallback inside `<picture>`

**VP-PERF-06: Dynamic import failure is handled gracefully**
- Mock `import("../../utils/parseMotionsExcel")` to reject
- Attempt to upload a motions file
- Assert an error state is shown rather than an unhandled crash

### State-based scenarios

**VP-PERF-07: Second page load uses cached assets**
- Load the voter app (first load — assets fetched from CDN)
- Reload the page
- Assert that `/assets/*.js` requests return from browser cache (HTTP 304 or served from disk cache, `Cache-Control: immutable`)

---

## Vertical Slice Decomposition

All five items in this slice are independent of each other and can be implemented in any order. However, items 2 and 3 (CDN serving + immutable headers) share the same `vercel.json` edit and should be implemented together. The recommended implementation order:

1. Items 2+3 together (`vercel.json` CDN fix + headers)
2. Item 1 (xlsx dynamic import + manualChunks)
3. Item 4 (logo WebP)
4. Item 5 (Brotli pre-compression)

This slice has **no dependency** on Slice B (motion count fix).
