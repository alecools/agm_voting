import { test, expect } from "../fixtures";

/**
 * E2E tests for the Admin Settings (tenant branding) page.
 *
 * These tests run against the deployed preview URL. They always restore the
 * original app_name after mutating it so the suite is idempotent.
 */

const ORIGINAL_APP_NAME = "AGM Voting";
const ORIGINAL_PRIMARY_COLOUR = "#005f73";

// The Settings page has two inputs associated with the "Primary colour" label:
// the colour picker (aria-label="Primary colour picker") and the hex text field
// (id="primary-colour-text", label="Primary colour"). Use the text field ID
// directly to avoid Playwright strict-mode violations.
const primaryColourText = (page: import("@playwright/test").Page) =>
  page.locator("#primary-colour-text");

test.describe("Admin Settings — tenant branding", () => {
  // --- Navigation ---

  test("Settings link in sidebar navigates to the settings page", async ({ page }) => {
    await page.goto("/admin/buildings");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page).toHaveURL(/\/admin\/settings/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("settings page renders all four form fields", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();
    await expect(page.getByLabel("Logo URL")).toBeVisible();
    await expect(primaryColourText(page)).toBeVisible();
    await expect(page.getByLabel("Support email")).toBeVisible();
  });

  test("settings page shows Save button", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  });

  // --- Happy path: save and confirm branding updates ---

  test("saving a new app name shows success message", async ({ page }) => {
    const testAppName = `E2E Settings ${Date.now()}`;

    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();

    // Update app name and save
    await page.getByLabel("App name").fill(testAppName);
    await page.getByRole("button", { name: "Save" }).click();

    // Success banner appears
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // Restore original app name so the suite is idempotent
    await page.getByLabel("App name").fill(ORIGINAL_APP_NAME);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
  });

  test("sidebar app name updates after save (live branding re-fetch)", async ({ page }) => {
    const testAppName = `E2E Branding ${Date.now()}`;

    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();

    // Store original sidebar text for comparison
    const sidebar = page.locator(".admin-sidebar__app-name, .admin-sidebar__logo").first();

    // Update app name and save
    await page.getByLabel("App name").fill(testAppName);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // After invalidateQueries triggers a refetch, the sidebar span should update.
    // Use a generous timeout to allow for Lambda re-fetch latency.
    await expect(page.locator(".admin-sidebar__app-name").first()).toHaveText(testAppName, {
      timeout: 15000,
    });

    // Restore original app name so the suite is idempotent
    await page.getByLabel("App name").fill(ORIGINAL_APP_NAME);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    await expect(page.locator(".admin-sidebar__app-name").first()).toHaveText(ORIGINAL_APP_NAME, {
      timeout: 15000,
    });
  });

  test("success message disappears after a few seconds", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    // Message auto-hides after 3 s
    await expect(page.getByText("Settings saved.")).not.toBeVisible({ timeout: 5000 });
  });

  test("form is pre-populated with current config from server", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();
    // App name field should be populated (not blank)
    const appNameValue = await page.getByLabel("App name").inputValue();
    expect(appNameValue.length).toBeGreaterThan(0);
    // Primary colour text field should look like a hex value
    const colourValue = await primaryColourText(page).inputValue();
    expect(colourValue).toMatch(/^#[0-9a-fA-F]{3,6}$/);
  });

  // --- Validation errors ---

  test("saving with empty app name does not show success", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();
    await page.getByLabel("App name").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    // HTML5 required validation prevents submit — no success message appears
    await expect(page.getByText("Settings saved.")).not.toBeVisible();
  });

  test("saving with invalid hex colour shows error", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(primaryColourText(page)).toBeVisible();
    await primaryColourText(page).fill("notacolour");
    await page.getByRole("button", { name: "Save" }).click();
    // Backend returns 422 — frontend shows HTTP error message
    // (The 422 console log is suppressed in fixtures.ts IGNORED_PATTERNS)
    await expect(page.getByText(/HTTP 422|Failed to save/)).toBeVisible({ timeout: 10000 });

    // Restore valid colour
    await primaryColourText(page).fill(ORIGINAL_PRIMARY_COLOUR);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
  });
});
