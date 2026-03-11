/**
 * Smoke tests — run against any deployed environment to verify:
 *   1. The API is reachable and returning data
 *   2. The frontend loads and renders without console errors
 *   3. No wrong base URL, missing env vars, or DB migration issues
 *
 * Usage:
 *   # Local
 *   npx playwright test e2e/smoke.spec.ts
 *
 *   # Against a deployed URL
 *   PLAYWRIGHT_BASE_URL=https://agm-voting-git-preview-ocss.vercel.app \
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=yourpassword \
 *   npx playwright test e2e/smoke.spec.ts
 */
import { test, expect } from "./fixtures";

test.describe("API health", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  test("public buildings endpoint returns an array", async ({ request }) => {
    const res = await request.get("/api/buildings");
    expect(res.ok()).toBeTruthy();
    const buildings = await res.json() as unknown[];
    expect(Array.isArray(buildings)).toBe(true);
  });
});

test.describe("Voter flow", () => {
  test("home page loads and shows building selector without console errors", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Select your building")).toBeVisible();
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

test.describe("Admin flow", () => {
  test("admin login page loads without console errors", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.getByRole("heading", { name: "Admin Portal" })).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("admin login succeeds and redirects to buildings", async ({ page }) => {
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin";

    await page.goto("/admin/login");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/admin\/buildings/);
  });

  test("admin buildings page loads data after login without console errors", async ({ page }) => {
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin";

    await page.goto("/admin/login");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin\/buildings/);

    // Table should be visible and populated
    await expect(page.getByRole("table")).toBeVisible();
  });
});
