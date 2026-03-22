import { test, expect } from "../fixtures";

/**
 * E2E tests for the Admin Settings (tenant branding) page.
 *
 * These tests run against the deployed preview URL. They always restore the
 * original app_name after mutating it so the suite is idempotent.
 */

const ORIGINAL_APP_NAME = "AGM Voting";
const ORIGINAL_PRIMARY_COLOUR = "#005f73";

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
    await expect(page.getByLabel("Primary colour")).toBeVisible();
    await expect(page.getByLabel("Support email")).toBeVisible();
  });

  test("settings page shows Save button", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  });

  // --- Happy path: save and confirm branding updates ---

  test("saving a new app name shows success message and updates sidebar", async ({ page }) => {
    const testAppName = `E2E Settings ${Date.now()}`;

    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();

    // Update app name
    await page.getByLabel("App name").fill(testAppName);
    await page.getByRole("button", { name: "Save" }).click();

    // Success banner appears
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // Sidebar app name updates immediately (branding re-fetched via React Query invalidation)
    await expect(page.getByText(testAppName).first()).toBeVisible();

    // Restore original app name so the suite is idempotent
    await page.getByLabel("App name").fill(ORIGINAL_APP_NAME);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
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
    // App name field should be populated (not blank)
    const appNameValue = await page.getByLabel("App name").inputValue();
    expect(appNameValue.length).toBeGreaterThan(0);
    // Primary colour should look like a hex value
    const colourValue = await page.getByLabel("Primary colour").inputValue();
    expect(colourValue).toMatch(/^#[0-9a-fA-F]{3,6}$/);
  });

  // --- Validation errors ---

  test("saving with empty app name shows validation error", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByLabel("App name")).toBeVisible();
    await page.getByLabel("App name").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    // HTML5 required validation prevents submit, or backend returns 422
    // Either way no "Settings saved." message should appear
    await expect(page.getByText("Settings saved.")).not.toBeVisible();
  });

  test("saving with invalid hex colour shows error", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByLabel("Primary colour")).toBeVisible();
    await page.getByLabel("Primary colour").fill("notacolour");
    await page.getByRole("button", { name: "Save" }).click();
    // Backend returns 422 — frontend shows HTTP error message
    await expect(page.getByText(/HTTP 422|Failed to save/)).toBeVisible({ timeout: 5000 });

    // Restore valid colour
    await page.getByLabel("Primary colour").fill(ORIGINAL_PRIMARY_COLOUR);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
  });
});
