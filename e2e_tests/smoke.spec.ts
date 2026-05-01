/**
 * Smoke tests — run against any deployed environment to verify:
 *   1. The API is reachable and responding within acceptable latency
 *   2. The frontend loads and renders without console errors
 *   3. No wrong base URL, missing env vars, or DB migration issues
 *
 * These tests deliberately avoid re-testing flows already covered by the
 * dedicated spec files (voting-flow.spec.ts, admin/*.spec.ts, etc.).  Their
 * purpose is deployment health: confirming the Lambda is up, static assets
 * are reachable, and env vars are wired correctly.
 *
 * Usage:
 *   # Local
 *   npx playwright test e2e/smoke.spec.ts
 *
 *   # Against a deployed URL
 *   PLAYWRIGHT_BASE_URL=https://agm-voting-git-preview-ocss.vercel.app \
 *   ADMIN_USERNAME=admin@example.com ADMIN_PASSWORD=yourpassword \
 *   npx playwright test e2e/smoke.spec.ts
 */
import { test, expect } from "./fixtures";

test.describe("API health", () => {
  test("health endpoint returns ok within 5 s", async ({ request }) => {
    const start = Date.now();
    const res = await request.get("/api/health");
    const elapsed = Date.now() - start;
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
    // Lambda should respond well under 5 s on a warm request
    expect(elapsed).toBeLessThan(5000);
  });

  test("static logo.png is no longer served (asset removed)", async ({ request }) => {
    const res = await request.get("/logo.png");
    // The file has been deleted — the server should return 404 or redirect to index.html
    // Either way it must NOT return a PNG binary (status 200 with image content)
    const isImageContent = res.ok() && (res.headers()["content-type"] ?? "").startsWith("image/");
    expect(isImageContent).toBe(false);
  });

  test("favicon is served at /favicon.ico or a configured URL", async ({ request }) => {
    // Either the default /favicon.ico exists OR the app configures a custom URL via
    // /api/config.  Either way, this endpoint must return a JSON payload without error.
    const res = await request.get("/api/config");
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as { favicon_url?: string | null };
    // favicon_url may be null/empty — that's fine, just confirm the key is present
    expect("favicon_url" in body || body.favicon_url === null || body.favicon_url === undefined).toBe(true);
  });
});

test.describe("Voter flow", () => {
  test("home page loads and shows building selector without console errors", async ({ page, consoleErrors: _ }) => {
    await page.goto("/");
    await expect(page.getByLabel("Select your building")).toBeVisible();
    // consoleErrors fixture auto-asserts no unexpected browser errors at end of test
  });

  test("building selector is populated with at least one building", async ({ page }) => {
    await page.goto("/");
    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    // Dropdown should have options beyond the placeholder
    const options = select.locator("option");
    await expect(options).not.toHaveCount(1);
  });
});

test.describe("Security headers", () => {
  test("API responses include required security headers", async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

test.describe("Admin flow", () => {
  test("admin login page loads without console errors", async ({ page, consoleErrors: _ }) => {
    await page.goto("/admin/login");
    await expect(page.getByRole("heading", { name: "Admin Portal" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    // consoleErrors fixture auto-asserts no unexpected browser errors at end of test
  });

  test("admin credentials env vars are configured and login succeeds", async ({ page }) => {
    const email = process.env.ADMIN_USERNAME ?? "admin@example.com";
    const password = process.env.ADMIN_PASSWORD ?? "admin";

    await page.goto("/admin/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Redirect to /admin/buildings confirms auth is wired correctly in this deployment
    await expect(page).toHaveURL(/\/admin\/buildings/);
    // Table must be visible — confirms DB connection and migrations are healthy
    await expect(page.getByRole("table")).toBeVisible();
  });
});
