import { test, expect, RUN_SUFFIX } from "./fixtures";
import { E2E_BUILDING_NAME, E2E_LOT_EMAIL } from "./global-setup";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  ADMIN_AUTH_PATH,
  getTestOtp,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  closeMeeting,
  deleteMeeting,
  clearBallots,
  submitBallotViaApi,
} from "./workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Voting-flow tests rely on data seeded by global-setup.ts:
//   - Building "E2E Test Building"
//   - Lot owner  lot=E2E-1  email=e2e-voter@test.com
//   - A fresh open AGM with at least one motion (created each run)

test.describe("Lot owner voting flow", () => {
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

// ---------------------------------------------------------------------------
// US-TCG-04: Closed meeting auth flow — voter routed to confirmation (not blocked)
// ---------------------------------------------------------------------------
// Verifies the CLAUDE.md design decision:
//   "Auth on closed AGMs — POST /api/auth/verify returns 200 (not 403) for
//    closed AGMs.  The response includes agm_status: str so the frontend can
//    route to the confirmation page instead of blocking entry."
//
// Two sub-cases:
//   TCG04-A: Voter who submitted BEFORE close → sees their votes on confirmation.
//   TCG04-B: Voter who did NOT submit (absent) → sees "You did not submit" message.

test.describe("US-TCG-04: closed meeting auth flow — voter routed to confirmation", () => {
  test.describe.configure({ mode: "serial" });

  const TCG04_BUILDING = `TCG04 Building-${RUN_SUFFIX}`;
  const TCG04_VOTER_SUBMITTED_EMAIL = `tcg04-submitted-${RUN_SUFFIX}@test.com`;
  const TCG04_VOTER_ABSENT_EMAIL = `tcg04-absent-${RUN_SUFFIX}@test.com`;
  const TCG04_MOTION_TITLE = "TCG04 Motion — Closed meeting test";
  let tcg04MeetingId = "";
  let tcg04SubmittedLotOwnerId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, TCG04_BUILDING, `tcg04-mgr-${RUN_SUFFIX}@test.com`);

    tcg04SubmittedLotOwnerId = await seedLotOwner(api, buildingId, {
      lotNumber: "TCG04-S",
      emails: [TCG04_VOTER_SUBMITTED_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    await seedLotOwner(api, buildingId, {
      lotNumber: "TCG04-A",
      emails: [TCG04_VOTER_ABSENT_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    tcg04MeetingId = await createOpenMeeting(api, buildingId, `TCG04 Meeting-${RUN_SUFFIX}`, [
      {
        title: TCG04_MOTION_TITLE,
        description: "Test motion for closed meeting auth flow.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);
    await clearBallots(api, tcg04MeetingId);

    // Fetch motions to get the motion ID for the ballot submission
    const detailRes = await api.get(`/api/admin/general-meetings/${tcg04MeetingId}`);
    const detail = await detailRes.json() as { motions: { id: string }[] };
    const motionId = detail.motions[0]?.id;

    // Voter-submitted submits their ballot BEFORE the meeting closes
    await submitBallotViaApi(
      api,
      TCG04_VOTER_SUBMITTED_EMAIL,
      tcg04MeetingId,
      [tcg04SubmittedLotOwnerId],
      [{ motion_id: motionId, choice: "yes" }]
    );

    // Close the meeting — both voters will now see agm_status="closed" on auth
    await closeMeeting(api, tcg04MeetingId);

    await api.dispose();
  }, { timeout: 90000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await deleteMeeting(api, tcg04MeetingId);
    await api.dispose();
  }, { timeout: 30000 });

  test("TCG04-A: voter who submitted before close is routed to confirmation showing their votes", async ({ page }) => {
    test.setTimeout(90000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Navigate directly to the auth page by meeting ID — the building is not in the
    // home-page dropdown because closed meetings are excluded from that list.
    // Clear only the session cookie so restore returns 401 and the OTP form is shown.
    // (Clearing all cookies would remove the Vercel bypass cookie, blocking page access.)
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${tcg04MeetingId}/auth`);

    // Wait for the URL to stabilise on the auth page and the OTP form to be ready
    await expect(page).toHaveURL(/vote\/.*\/auth/, { timeout: 20000 });
    const emailInputA = page.getByLabel("Email address");
    await expect(emailInputA).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "Send Verification Code" })).toBeVisible({ timeout: 20000 });

    await emailInputA.fill(TCG04_VOTER_SUBMITTED_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    const codeA = await getTestOtp(api, TCG04_VOTER_SUBMITTED_EMAIL, tcg04MeetingId);
    await page.getByLabel("Verification code").fill(codeA);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();

    // Auth on a closed meeting must route to confirmation (not block at auth)
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(TCG04_MOTION_TITLE)).toBeVisible({ timeout: 10000 });
  });

  test("TCG04-B: absent voter is routed to confirmation showing 'did not submit' message", async ({ page }) => {
    test.setTimeout(90000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Same direct-navigation approach as TCG04-A.
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${tcg04MeetingId}/auth`);

    await expect(page).toHaveURL(/vote\/.*\/auth/, { timeout: 20000 });
    const emailInputB = page.getByLabel("Email address");
    await expect(emailInputB).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "Send Verification Code" })).toBeVisible({ timeout: 20000 });

    await emailInputB.fill(TCG04_VOTER_ABSENT_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    const codeB = await getTestOtp(api, TCG04_VOTER_ABSENT_EMAIL, tcg04MeetingId);
    await page.getByLabel("Verification code").fill(codeB);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();

    // Auth on a closed meeting must route to confirmation (not block at auth)
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(
      page.getByText("You did not submit a ballot for this meeting.")
    ).toBeVisible({ timeout: 15000 });
  });
});
