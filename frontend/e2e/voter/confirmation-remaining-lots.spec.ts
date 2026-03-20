/**
 * E2E tests: confirmation page "Vote for remaining lots" button.
 *
 * When a multi-lot voter submits votes for some but not all of their lots, the
 * confirmation page shows a "Vote for remaining lots" button. Clicking it
 * navigates back to /voting where the already-submitted lot shows the
 * "Already submitted" badge and the remaining lot is still selectable.
 *
 * Scenarios:
 *   CRL.1 — 2-lot voter submits Lot A → confirmation page shows "Vote for
 *            remaining lots" button → click → /voting page → Lot B selectable,
 *            Lot A shows "Already submitted"
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  clearBallots,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
} from "../workflows/helpers";

const CRL_BUILDING = `CRL01 Remaining Lots Building-${RUN_SUFFIX}`;
const CRL_LOT_A = "CRL01-A";
const CRL_LOT_B = "CRL01-B";
const CRL_EMAIL = `crl01-voter-${RUN_SUFFIX}@test.com`;

let crlMeetingId = "";

test.describe("CRL.1: Confirmation page Vote for remaining lots", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, CRL_BUILDING, `crl01-mgr-${RUN_SUFFIX}@test.com`);

    // Create two lots with the same email (shared voter)
    await seedLotOwner(api, buildingId, {
      lotNumber: CRL_LOT_A,
      emails: [CRL_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: CRL_LOT_B,
      emails: [CRL_EMAIL],
      unitEntitlement: 20,
      financialPosition: "normal",
    });

    crlMeetingId = await createOpenMeeting(api, buildingId, `CRL01 Meeting-${RUN_SUFFIX}`, [
      { title: "CRL01 Motion 1", description: "Test motion for remaining lots.", orderIndex: 0, motionType: "general" },
    ]);

    await clearBallots(api, crlMeetingId);
    await api.dispose();
  }, { timeout: 60000 });

  test("CRL.1: submit Lot A only → confirmation shows Vote for remaining lots → click → Lot B selectable", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Authenticate as the shared voter — both lots appear
    await goToAuthPage(page, CRL_BUILDING);
    await authenticateVoter(page, CRL_EMAIL, () => getTestOtp(api, CRL_EMAIL, crlMeetingId));
    await api.dispose();

    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Both lots should be visible in the sidebar (scope to desktop sidebar to avoid strict-mode
    // violation — lotListContent is rendered in both the desktop sidebar and the mobile drawer)
    const sidebar = page.locator(".voting-layout__sidebar");
    await expect(sidebar.getByText(`Lot ${CRL_LOT_A}`, { exact: true }).first()).toBeVisible({ timeout: 15000 });
    await expect(sidebar.getByText(`Lot ${CRL_LOT_B}`, { exact: true }).first()).toBeVisible({ timeout: 15000 });

    // Deselect Lot B — only Lot A will be submitted
    const lotBCheckbox = page.getByLabel(`Select Lot ${CRL_LOT_B}`).first();
    await lotBCheckbox.uncheck();

    // Vote on the single motion and submit for Lot A only
    const motionCard = page.locator(".motion-card").first();
    await expect(motionCard).toBeVisible({ timeout: 15000 });
    await motionCard.getByRole("button", { name: "For" }).click();

    await page.getByRole("button", { name: "Submit ballot" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Submit ballot" }).last().click();

    // Should land on confirmation page
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // "Vote for remaining lots" button must be visible (Lot B not yet submitted)
    await expect(page.getByRole("button", { name: "Vote for remaining lots" })).toBeVisible({ timeout: 10000 });

    // Click it — navigate back to /voting
    await page.getByRole("button", { name: "Vote for remaining lots" }).click();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });

    // Lot A must show "Already submitted" badge and be disabled
    const lotAItem = page.locator(".lot-selection__item").filter({ hasText: `Lot ${CRL_LOT_A}` }).first();
    await expect(lotAItem.getByText("Already submitted")).toBeVisible({ timeout: 10000 });
    const lotACheckbox = page.getByLabel(`Select Lot ${CRL_LOT_A}`).first();
    await expect(lotACheckbox).toBeDisabled();

    // Lot B must still be selectable (not submitted)
    const lotBCheckboxAfter = page.getByLabel(`Select Lot ${CRL_LOT_B}`).first();
    await expect(lotBCheckboxAfter).not.toBeDisabled();
    await expect(lotBCheckboxAfter).toBeChecked();
  });
});
