import { test as base, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export { expect };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the branch-name suffix written by global-setup so every spec can
// namespace its seeded entity names without re-computing the branch name.
const suffixFile = path.join(__dirname, ".run-suffix");
export const RUN_SUFFIX = fs.existsSync(suffixFile)
  ? fs.readFileSync(suffixFile, "utf-8").trim()
  : "local";

// Console/network error patterns that are safe to ignore
const IGNORED_PATTERNS = [
  /favicon/i,
  /\[vite\]/i,
  // React DevTools noise in dev builds
  /Download the React DevTools/i,
  // Google Fonts CORS: the Vercel bypass header gets sent to external CDNs
  // (side-effect of extraHTTPHeaders in playwright.config.ts) — not an app error
  /fonts\.gstatic\.com.*x-vercel-protection-bypass/i,
  /fonts\.googleapis\.com.*x-vercel-protection-bypass/i,
  /x-vercel-protection-bypass is not allowed by Access-Control-Allow-Headers/i,
  // 401 from /api/auth/verify is expected in the "failed authentication" test —
  // the browser logs "Failed to load resource: status of 401" for intentional
  // wrong-credential submissions, which is correct app behaviour not an error.
  /status of 401/i,
  // 404 from /api/general-meeting/{id}/summary is expected in the "invalid AGM ID
  // shows not-found state" test — the test deliberately uses a non-existent UUID
  // to verify that the component renders the "Meeting not found" fallback UI.
  /status of 404/i,
  // 422 from /api/admin/config is expected in the "saving with invalid hex colour"
  // E2E test — the browser logs this when the backend rejects an invalid colour value,
  // which is the correct validation behaviour being tested.
  /status of 422/i,
  // Vercel injects a live-preview toolbar that tries to frame https://vercel.live/
  // The app's CSP blocks it (default-src 'self'). This is Vercel infrastructure
  // noise and not an application error.
  /vercel\.live/i,
  /Content Security Policy directive.*default-src/i,
  // Image/asset loads from Vercel Blob storage can return 403 when the asset URL
  // has not been publicly shared or the access token is missing. This is a
  // configuration concern, not an application error — suppress the browser noise.
  /net::ERR_FAILED.*\.(png|svg|ico|jpg|webp)/i,
  /blob\.vercel-storage\.com/i,
  /net::ERR_FAILED.*403/i,
  // Google Identity Services / FedCM noise: Chrome's browser-level sign-in
  // API (FedCM) fires these errors when no Google account is logged in or the
  // provider rejects the request.  These are browser/OS-level signals unrelated
  // to the application and appear on any direct URL navigation.
  /Provider's accounts list is empty/i,
  /GSI_LOGGER/i,
  /FedCM get\(\) rejects/i,
  // Generic 403/429 from an empty URL "()": emitted by Chrome when browser-level
  // credential/sign-in resources are blocked.  Empty URL means it is not from
  // our /api/ endpoints (which always include the full path).
  /status of 403 \(\)/i,
  /status of 429 \(\)/i,
];

/**
 * Extended test fixture that automatically captures browser console errors,
 * uncaught exceptions, and failed API requests. Fails the test if any are
 * detected — this catches issues like wrong API base URLs, missing env vars,
 * and runtime crashes that would otherwise only be visible in DevTools.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];

      // Capture console.error() calls from the app
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (!IGNORED_PATTERNS.some((p) => p.test(text))) {
            errors.push(`[console] ${text}`);
          }
        }
      });

      // Capture uncaught JS exceptions
      page.on("pageerror", (err) => {
        errors.push(`[uncaught] ${err.message}`);
      });

      // Capture failed network requests to our API — catches wrong base URL,
      // connection refused (e.g. VITE_API_BASE_URL pointing to localhost),
      // and other network-level failures.
      // ERR_ABORTED is excluded: it fires when page.goto() navigates away while
      // requests are still in-flight, which is expected behaviour, not an error.
      page.on("requestfailed", (req) => {
        const url = req.url();
        const errorText = req.failure()?.errorText ?? "unknown";
        if (url.includes("/api/") && !errorText.includes("ERR_ABORTED")) {
          errors.push(
            `[network] ${req.method()} ${url} failed: ${errorText}`
          );
        }
      });

      await use(errors);

      if (errors.length > 0) {
        throw new Error(
          `Browser errors detected:\n${errors.map((e) => `  • ${e}`).join("\n")}`
        );
      }
    },
    { auto: true }, // applied automatically to every test
  ],
});
