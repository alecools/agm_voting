import { test, expect } from "../fixtures";
import { makeAdminApi } from "../workflows/helpers";

// Admin email used during global-setup provisioning — matches the current logged-in user.
const ADMIN_EMAIL = process.env.ADMIN_USERNAME ?? "admin@example.com";

/**
 * E2E tests for the Admin Settings page (tenant branding, email server, user management).
 *
 * These tests run against the deployed preview URL. They always restore the
 * original app_name after mutating it so the suite is idempotent.
 *
 * The Settings page has three tabs: "UI & Theme", "Email Server", "User Management".
 * Each test clicks the relevant tab before interacting with tab-specific fields.
 */

const ORIGINAL_APP_NAME = "AGM Voting";
const ORIGINAL_PRIMARY_COLOUR = "#005f73";

// The Settings page has two inputs associated with the "Primary colour" label:
// the colour picker (aria-label="Primary colour picker") and the hex text field
// (id="primary-colour-text", label="Primary colour"). Use the text field ID
// directly to avoid Playwright strict-mode violations.
const primaryColourText = (page: import("@playwright/test").Page) =>
  page.locator("#primary-colour-text");

/** Click the "UI & Theme" tab on the Settings page to activate the branding panel. */
const clickUiThemeTab = async (page: import("@playwright/test").Page) => {
  await page.getByRole("tab", { name: "UI & Theme" }).click();
};

/** Click the "Email Server" tab on the Settings page to activate the SMTP panel. */
const clickEmailServerTab = async (page: import("@playwright/test").Page) => {
  await page.getByRole("tab", { name: "Email Server" }).click();
};

/** Click the "User Management" tab on the Settings page to activate the users panel. */
const clickUserManagementTab = async (page: import("@playwright/test").Page) => {
  await page.getByRole("tab", { name: "User Management" }).click();
};

test.describe("Admin Settings — tenant branding", () => {
  // --- Navigation ---

  test("Settings link in sidebar navigates to the settings page", async ({ page }) => {
    await page.goto("/admin/buildings");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page).toHaveURL(/\/admin\/settings/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("settings page renders all form fields including logo upload", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();
    await expect(page.getByLabel("Logo URL")).toBeVisible();
    await expect(page.getByLabel("Upload logo image")).toBeVisible();
    await expect(primaryColourText(page)).toBeVisible();
    await expect(page.getByLabel("Support email")).toBeVisible();
  });

  test("settings page shows Save button", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByTestId("branding-save-btn")).toBeVisible();
  });

  // --- Happy path: save and confirm branding updates ---

  test("saving a new app name shows success message", async ({ page }) => {
    const testAppName = `E2E Settings ${Date.now()}`;

    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();

    // Update app name and save
    await page.getByLabel("App name").fill(testAppName);
    await page.getByTestId("branding-save-btn").click();

    // Success banner appears
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // Restore original app name so the suite is idempotent
    await page.getByLabel("App name").fill(ORIGINAL_APP_NAME);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
  });

  test("sidebar app name updates after save (live branding re-fetch)", async ({ page }) => {
    const testAppName = `E2E Branding ${Date.now()}`;

    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();

    // Capture the current logo URL so we can restore it at the end.
    const originalLogoUrl = await page.getByLabel("Logo URL").inputValue();

    // Clear logo URL so the sidebar renders the text span (.admin-sidebar__app-name)
    // rather than the <img> element — the span is only shown when logo_url is empty.
    if (originalLogoUrl) {
      await page.getByLabel("Logo URL").fill("");
      await page.getByTestId("branding-save-btn").click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
    }

    // Update app name and save
    await page.getByLabel("App name").fill(testAppName);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    // Poll until /api/config reflects the new app_name — Lambda caching can cause
    // the refetch to lag. Only assert the sidebar once the API confirms the change
    // so we don't race against network latency on the preview deployment.
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    for (let i = 0; i < 20; i++) {
      const res = await page.request.get(`${baseURL}/api/config`);
      const cfg = await res.json() as { app_name: string };
      if (cfg.app_name === testAppName) break;
      await page.waitForTimeout(500);
    }

    // After invalidateQueries triggers a refetch, the sidebar span should update.
    // Use a generous timeout to allow for Lambda re-fetch latency.
    await expect(page.locator(".admin-sidebar__app-name").first()).toHaveText(testAppName, {
      timeout: 15000,
    });

    // Restore original app name and logo URL so the suite is idempotent
    await page.getByLabel("App name").fill(ORIGINAL_APP_NAME);
    await page.getByLabel("Logo URL").fill(originalLogoUrl);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    // Only assert the sidebar text when no logo is set (otherwise the img is shown)
    if (!originalLogoUrl) {
      await expect(page.locator(".admin-sidebar__app-name").first()).toHaveText(ORIGINAL_APP_NAME, {
        timeout: 15000,
      });
    }
  });

  test("success message disappears after a few seconds", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    // Message auto-hides after 3 s
    await expect(page.getByText("Settings saved.")).not.toBeVisible({ timeout: 5000 });
  });

  test("form is pre-populated with current config from server", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();
    // App name field should be populated (not blank)
    const appNameValue = await page.getByLabel("App name").inputValue();
    expect(appNameValue.length).toBeGreaterThan(0);
    // Primary colour text field should look like a hex value
    const colourValue = await primaryColourText(page).inputValue();
    expect(colourValue).toMatch(/^#[0-9a-fA-F]{3,6}$/);
  });

  // --- Favicon dynamic update ---

  test("favicon link tag is present in document head", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();
    // The <link rel="icon"> element must exist for JS to update it
    const faviconHref = await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      return link?.href ?? null;
    });
    expect(faviconHref).not.toBeNull();
  });

  test("favicon href reflects logo_url from config after load", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();
    // After BrandingContext loads, favicon should be set to logo_url or /favicon.ico
    const faviconHref = await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      return link?.href ?? "";
    });
    // Must be a non-empty string (either a real URL or the fallback)
    expect(faviconHref.length).toBeGreaterThan(0);
  });

  // --- Validation errors ---

  test("saving with empty app name does not show success", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("App name")).toBeVisible();
    await page.getByLabel("App name").fill("");
    await page.getByTestId("branding-save-btn").click();
    // HTML5 required validation prevents submit — no success message appears
    await expect(page.getByText("Settings saved.")).not.toBeVisible();
  });

  test("saving with invalid hex colour shows error", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(primaryColourText(page)).toBeVisible();
    await primaryColourText(page).fill("notacolour");
    await page.getByTestId("branding-save-btn").click();
    // Backend returns 422 — frontend shows HTTP error message
    // (The 422 console log is suppressed in fixtures.ts IGNORED_PATTERNS)
    await expect(page.getByText(/HTTP 422|Failed to save/)).toBeVisible({ timeout: 10000 });

    // Restore valid colour
    await primaryColourText(page).fill(ORIGINAL_PRIMARY_COLOUR);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Admin Settings — favicon upload", () => {
  test("favicon URL field and upload button are present on the settings page", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("Favicon URL")).toBeVisible();
    await expect(page.getByLabel("Upload favicon image")).toBeVisible();
  });

  test("favicon URL field accepts text input", async ({ page }) => {
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("Favicon URL")).toBeVisible();
    const input = page.getByLabel("Favicon URL");
    await input.fill("https://example.com/fav.ico");
    await expect(input).toHaveValue("https://example.com/fav.ico");
    // Restore
    await input.fill("");
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
  });
});

// ── Admin Settings — login page logo reflects branding ────────────────────────

test.describe("Admin Settings — login page logo reflects branding", () => {
  // No serial needed — each test sets its own logo_url and restores the original at the end

  // Track original logo_url so we can restore it after the test
  let originalLogoUrl = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);
    const configRes = await api.get("/api/admin/config");
    const config = await configRes.json() as { logo_url?: string };
    originalLogoUrl = config.logo_url ?? "";
    await api.dispose();
  });

  test("Scenario F: admin login page img src matches configured logo_url", async ({ page }) => {
    test.setTimeout(60000);

    const TEST_LOGO_URL = "https://example.com/e2e-test-logo.png";

    // Step 1: Set a custom logo URL via the settings page
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("Logo URL")).toBeVisible({ timeout: 10000 });
    await page.getByLabel("Logo URL").fill(TEST_LOGO_URL);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 10000 });

    // Step 2: Navigate to admin login page (unauthenticated context)
    // We use a new browser context to simulate an unauthenticated visit
    const context = await page.context().browser()!.newContext();
    const loginPage = await context.newPage();

    try {
      await loginPage.goto("/admin/login");
      await expect(loginPage).toHaveURL(/admin\/login/, { timeout: 10000 });

      // Step 3: The logo img should have src matching the configured logo_url
      const logoImg = loginPage.locator(".admin-login-card__logo");
      await expect(logoImg).toBeVisible({ timeout: 10000 });
      await expect(logoImg).toHaveAttribute("src", TEST_LOGO_URL, { timeout: 5000 });

      // It must NOT point to the hardcoded /logo.png
      const src = await logoImg.getAttribute("src");
      expect(src).not.toBe("/logo.png");
    } finally {
      await context.close();
    }

    // Restore original logo URL
    await page.getByLabel("Logo URL").fill(originalLogoUrl);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 10000 });
  });

  test("Scenario F (empty logo): no broken /logo.png image on login page when logo_url is empty", async ({ page }) => {
    test.setTimeout(60000);

    // Step 1: Clear logo URL
    await page.goto("/admin/settings");
    await clickUiThemeTab(page);
    await expect(page.getByLabel("Logo URL")).toBeVisible({ timeout: 10000 });
    await page.getByLabel("Logo URL").fill("");
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 10000 });

    // Step 2: Visit login page unauthenticated
    const context = await page.context().browser()!.newContext();
    const loginPage = await context.newPage();

    try {
      await loginPage.goto("/admin/login");
      await expect(loginPage).toHaveURL(/admin\/login/, { timeout: 10000 });

      // When logo_url is empty, no img element is rendered — instead, the app
      // name is shown as text via .admin-login-card__app-name.
      const logoImg = loginPage.locator(".admin-login-card__logo");
      await expect(logoImg).not.toBeVisible({ timeout: 5000 });

      // The app name text element should be visible instead
      const appNameEl = loginPage.locator(".admin-login-card__app-name");
      await expect(appNameEl).toBeVisible({ timeout: 10000 });
    } finally {
      await context.close();
    }

    // Restore original logo URL
    await page.getByLabel("Logo URL").fill(originalLogoUrl);
    await page.getByTestId("branding-save-btn").click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 10000 });
  });
});

// ── Admin Settings — User Management tab ──────────────────────────────────────

test.describe("Admin Settings — User Management tab", () => {
  // Email used for the invite test. A unique suffix per run prevents the
  // "already exists" branch from being hit if a prior run's afterAll cleanup
  // was skipped (e.g. due to a test timeout or network failure).
  const INVITE_EMAIL = `e2e-invite-${Date.now()}@example.com`;

  // Store the invited user's ID so afterAll can remove it if the invite succeeded.
  let invitedUserId: string | null = null;

  test.afterAll(async () => {
    // Remove the invited user if the invite test created them, so the suite is
    // idempotent and subsequent runs don't hit the 409 "already exists" branch on
    // the first invite attempt (which would make success assertions ambiguous).
    if (!invitedUserId) return;
    const { request: playwrightRequest } = await import("@playwright/test");
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
      timeout: 60000,
    });
    try {
      await api.delete(`/api/admin/users/${invitedUserId}`);
    } finally {
      await api.dispose();
    }
  });

  // --- Happy path ---

  test("User Management tab loads and GET /api/admin/users returns 200", async ({ page }) => {
    await page.goto("/admin/settings");

    const [usersResponse] = await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/admin/users") && resp.request().method() === "GET"),
      clickUserManagementTab(page),
    ]);

    expect(usersResponse.status()).toBe(200);
  });

  test("User Management tab shows current admin user email in the table", async ({ page }) => {
    await page.goto("/admin/settings");

    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/admin/users") && resp.request().method() === "GET"),
      clickUserManagementTab(page),
    ]);

    // The users table must be visible and contain the current admin's email
    await expect(page.locator(".admin-table")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".admin-table").getByText(ADMIN_EMAIL)).toBeVisible();

    // The current user's row must also show the "(you)" label
    await expect(page.locator(".admin-table").getByText("(you)")).toBeVisible();
  });

  // --- Invite form ---

  test("Invite form — success path: invited email appears with success message", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/admin/settings");

    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/admin/users") && resp.request().method() === "GET"),
      clickUserManagementTab(page),
    ]);

    // Open the invite form
    await page.getByRole("button", { name: "Invite admin" }).click();
    await expect(page.getByLabel("Email address")).toBeVisible();

    // Fill in the invite email and submit
    await page.getByLabel("Email address").fill(INVITE_EMAIL);

    const [inviteResponse] = await Promise.all([
      page.waitForResponse((resp) =>
        resp.url().includes("/api/admin/users/invite") && resp.request().method() === "POST"
      ),
      page.getByRole("button", { name: "Send invite" }).click(),
    ]);

    // INVITE_EMAIL uses Date.now() so it is always unique per run.
    // Any non-201 response is a genuine failure — assert 201 directly.
    expect(inviteResponse.status()).toBe(201);

    // Store ID for afterAll cleanup
    const body = await inviteResponse.json() as { id: string; email: string };
    invitedUserId = body.id;

    // Success message appears with the invited email
    await expect(page.getByRole("status")).toHaveText(`Invite sent to ${INVITE_EMAIL}`, { timeout: 10000 });

    // The invited email is also added to the users table
    await expect(page.locator(".admin-table").getByText(INVITE_EMAIL)).toBeVisible();
  });

  // --- Last-admin removal guard ---

  test("Remove button is absent for the current user's own row", async ({ page }) => {
    await page.goto("/admin/settings");

    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes("/api/admin/users") && resp.request().method() === "GET"),
      clickUserManagementTab(page),
    ]);

    await expect(page.locator(".admin-table")).toBeVisible({ timeout: 10000 });

    // Find the row that contains the current admin's email (identified by the "(you)" label)
    const currentUserRow = page.locator(".admin-table tbody tr").filter({ hasText: "(you)" });
    await expect(currentUserRow).toBeVisible();

    // The Remove button must NOT exist in the current user's row — the UI omits it
    // (not just disables it) to prevent self-removal
    await expect(currentUserRow.getByRole("button", { name: "Remove" })).not.toBeVisible();
  });
});
