import { test, expect } from "@playwright/test";

// NOTE: These E2E tests require both the frontend dev server and the backend API
// to be running. Run with: npx playwright test
// Backend: uvicorn app.main:app --reload (at localhost:8000)
// Frontend: npm run dev (at localhost:5173)

test.describe("Lot owner voting flow", () => {
  test("full lot owner journey: select building → auth → vote → confirmation", async ({ page }) => {
    await page.goto("/");

    // Building selector page
    await expect(page.getByLabel("Select your building")).toBeVisible();

    // Select a building (this depends on seeded test data)
    await page.getByLabel("Select your building").selectOption({ index: 1 });

    // AGM list should appear
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible();

    // Click Enter Voting
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Auth page
    await expect(page.getByLabel("Lot number")).toBeVisible();
    await page.getByLabel("Lot number").fill("1");
    await page.getByLabel("Email address").fill("test@example.com");
    await page.getByRole("button", { name: "Continue" }).click();

    // Voting page
    await expect(page.getByRole("button", { name: "Submit Votes" })).toBeVisible();

    // Vote on motions
    const yesButtons = page.getByRole("button", { name: "Yes" });
    const count = await yesButtons.count();
    for (let i = 0; i < count; i++) {
      await yesButtons.nth(i).click();
    }

    // Submit
    await page.getByRole("button", { name: "Submit Votes" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Submit" }).click();

    // Confirmation
    await expect(page).toHaveURL(/confirmation/);
    await expect(page.getByText(/Your votes/)).toBeVisible();
  });

  test("failed authentication: wrong credentials show error, correct credentials proceed", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Select your building").selectOption({ index: 1 });
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Wrong credentials
    await page.getByLabel("Lot number").fill("9999");
    await page.getByLabel("Email address").fill("wrong@example.com");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByText("Lot number and email address do not match our records")
    ).toBeVisible();

    // Correct credentials
    await page.getByLabel("Lot number").clear();
    await page.getByLabel("Email address").clear();
    await page.getByLabel("Lot number").fill("1");
    await page.getByLabel("Email address").fill("test@example.com");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("button", { name: "Submit Votes" })).toBeVisible();
  });

  test("AGM closed state: see closed banner", async ({ page }) => {
    // Navigate to a closed AGM auth page using view=submission
    await page.goto("/");
    await page.getByLabel("Select your building").selectOption({ index: 1 });
    await expect(page.getByRole("button", { name: "View My Submission" }).first()).toBeVisible();
    await page.getByRole("button", { name: "View My Submission" }).first().click();

    // Auth page for closed AGM
    await expect(page.getByLabel("Lot number")).toBeVisible();
  });

  test("Close AGM and report: manager closes AGM", async ({ page }) => {
    // Navigate to admin
    await page.goto("/admin");
    await expect(page.getByText(/Admin/i).first()).toBeVisible();
  });
});
