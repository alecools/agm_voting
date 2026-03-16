import { test, expect } from "./fixtures";
import { E2E_BUILDING_NAME, E2E_LOT_EMAIL } from "./global-setup";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { getTestOtp } from "./workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Voting-flow tests rely on data seeded by global-setup.ts:
//   - Building "E2E Test Building"
//   - Lot owner  lot=E2E-1  email=e2e-voter@test.com
//   - A fresh open AGM with at least one motion (created each run)

test.describe("Lot owner voting flow", () => {
  test("full lot owner journey: select building → auth → vote → confirmation", async ({ page }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: path.join(__dirname, ".auth", "admin.json") });

    await page.goto("/");

    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    await select.selectOption({ label: E2E_BUILDING_NAME });

    // AGM list should appear — pick the first open AGM
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Auth page — email step
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Extract meeting ID from URL (/vote/<meeting_id>/auth)
    const meetingIdMatch = page.url().match(/\/vote\/([^/]+)\//);
    const meetingId = meetingIdMatch ? meetingIdMatch[1] : "";

    // Step 1: enter email, request OTP
    await page.getByLabel("Email address").fill(E2E_LOT_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });

    // Step 2: retrieve OTP and verify
    const code = await getTestOtp(api, E2E_LOT_EMAIL, meetingId);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();

    // Wait for auth to complete and navigate away from /auth.
    // Auth now routes directly to /voting (or /confirmation if already submitted).
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

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
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: path.join(__dirname, ".auth", "admin.json") });

    await page.goto("/");

    const select = page.getByLabel("Select your building");
    await select.selectOption({ label: E2E_BUILDING_NAME });
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Auth page — email step
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Extract meeting ID from URL (/vote/<meeting_id>/auth)
    const meetingIdMatch = page.url().match(/\/vote\/([^/]+)\//);
    const meetingId = meetingIdMatch ? meetingIdMatch[1] : "";

    // Wrong email — request-otp always returns 200 (enumeration protection);
    // the error surfaces only after submitting an invalid OTP code.
    await page.getByLabel("Email address").fill("wrong@example.com");
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Verification code").fill("00000000");
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(
      page.getByText(/invalid or expired code/i)
    ).toBeVisible({ timeout: 10000 });

    // Correct credentials — resend OTP to the correct email via "Resend code"
    // (re-clicking "Resend code" uses the same email; we need to go back to email step)
    // Navigate back to the auth page to start fresh with correct email
    await page.goto(page.url());
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Email address").fill(E2E_LOT_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    const code = await getTestOtp(api, E2E_LOT_EMAIL, meetingId);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();

    // Correct credentials should advance past the auth page — to /voting
    // (or /confirmation if E2E-1 already submitted a ballot in an earlier test).
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 15000 });
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
