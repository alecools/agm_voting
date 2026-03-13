import { test as base, expect } from "@playwright/test";

export { expect };

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
      page.on("requestfailed", (req) => {
        const url = req.url();
        if (url.includes("/api/")) {
          errors.push(
            `[network] ${req.method()} ${url} failed: ${req.failure()?.errorText ?? "unknown"}`
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
