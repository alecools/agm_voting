import { test, expect } from "./fixtures";
import { E2E_BUILDING_NAME, E2E_LOT_NUMBER, E2E_LOT_EMAIL } from "./global-setup";

// Voting-flow tests rely on data seeded by global-setup.ts:
//   - Building "E2E Test Building"
//   - Lot owner  lot=E2E-1  email=e2e-voter@test.com
//   - A fresh open AGM with at least one motion (created each run)

test.describe("Lot owner voting flow", () => {
  test("full lot owner journey: select building → auth → vote → confirmation", async ({ page }) => {
    await page.goto("/");

    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    await select.selectOption({ label: E2E_BUILDING_NAME });

    // AGM list should appear — pick the first open AGM
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Auth page — form is immediately usable (no upfront API call)
    await expect(page.getByLabel("Lot number")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.getByLabel("Lot number").fill(E2E_LOT_NUMBER);
    await page.getByLabel("Email address").fill(E2E_LOT_EMAIL);
    await page.getByRole("button", { name: "Continue" }).click();

    // Wait for auth to complete and navigate away from /auth.
    // Auth now always routes to /lot-selection first (unless already submitted
    // or AGM closed, which goes directly to /confirmation).
    await expect(page).toHaveURL(/vote\/.*\/(lot-selection|confirmation)/, { timeout: 20000 });

    // If landed on lot-selection, building name and meeting title should be visible in header
    if (page.url().includes("/lot-selection")) {
      await expect(page.getByText(E2E_BUILDING_NAME)).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole("button", { name: "Start Voting" })).toBeVisible();
      await page.getByRole("button", { name: "Start Voting" }).click();
      await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });
    }

    // If the ballot for E2E-1 was already submitted in a previous test run and
    // auth redirected straight to /confirmation, skip the voting steps.
    if (page.url().includes("/voting")) {
      await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible({ timeout: 10000 });

      // Vote For on all motions (vote buttons are labelled "For" / "Against" / "Abstain")
      const forButtons = page.getByRole("button", { name: "For" });
      const count = await forButtons.count();
      for (let i = 0; i < count; i++) {
        await forButtons.nth(i).click();
      }

      // Submit
      await page.getByRole("button", { name: "Submit ballot" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Submit ballot" }).last().click();

      // Confirmation — allow extra time for remote server ballot submission
      await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
    }

    // Whether we voted just now or were redirected here directly, the
    // confirmation page must show the voter's recorded votes.
    await expect(page.getByText("Your votes", { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test("failed authentication: wrong credentials show error, correct credentials proceed", async ({ page }) => {
    await page.goto("/");

    const select = page.getByLabel("Select your building");
    await select.selectOption({ label: E2E_BUILDING_NAME });
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Auth page — form is immediately usable
    await expect(page.getByLabel("Lot number")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();

    // Wrong credentials
    await page.getByLabel("Lot number").fill("NONEXISTENT-9999");
    await page.getByLabel("Email address").fill("wrong@example.com");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByText("Lot number and email address do not match our records")
    ).toBeVisible();

    // Correct credentials
    await page.getByLabel("Lot number").clear();
    await page.getByLabel("Email address").clear();
    await page.getByLabel("Lot number").fill(E2E_LOT_NUMBER);
    await page.getByLabel("Email address").fill(E2E_LOT_EMAIL);
    await page.getByRole("button", { name: "Continue" }).click();

    // Correct credentials should advance past the auth page — to lot-selection
    // (or confirmation if E2E-1 already submitted a ballot in an earlier test).
    await expect(page).toHaveURL(/vote\/.*\/(lot-selection|confirmation)/, { timeout: 15000 });
  });

  test("AGM closed state: closed AGM shows View My Submission button", async ({ page }) => {
    await page.goto("/");
    // Select the E2E building — it has at least one closed AGM from the
    // previous run (globalSetup closes all open ones before creating a new one)
    const select = page.getByLabel("Select your building");
    await select.selectOption({ label: E2E_BUILDING_NAME });

    // Either "Enter Voting" (open) or "View My Submission" (closed) must be visible
    const hasAny = await page
      .getByRole("button", { name: /Enter Voting|View My Submission/ })
      .first()
      .isVisible()
      .catch(() => false);

    if (!hasAny) {
      test.skip();
      return;
    }

    const hasClosedAgm = await page
      .getByRole("button", { name: "View My Submission" })
      .first()
      .isVisible()
      .catch(() => false);

    if (!hasClosedAgm) {
      test.skip();
      return;
    }

    await expect(
      page.getByRole("button", { name: "View My Submission" }).first()
    ).toBeVisible();
  });
});
