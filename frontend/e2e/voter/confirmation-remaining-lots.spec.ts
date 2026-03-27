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
    const adminApi = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Step 1: Authenticate as the shared voter via UI to get a real session token
    // and to populate sessionStorage with the lot info (including lot_owner_ids).
    await goToAuthPage(page, CRL_BUILDING);
    await authenticateVoter(page, CRL_EMAIL, () => getTestOtp(adminApi, CRL_EMAIL, crlMeetingId));
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });
    await page.waitForLoadState("networkidle");

    // Step 2: Collect lot owner IDs from sessionStorage.
    // The auth handler writes lot info to sessionStorage.
    // The session token is stored in an HttpOnly cookie — not accessible via localStorage.
    const lotsRaw = await page.evaluate(
      (id) => sessionStorage.getItem(`meeting_lots_info_${id}`),
      crlMeetingId
    );
    expect(lotsRaw).toBeTruthy();
    const lots = JSON.parse(lotsRaw as string) as Array<{ lot_owner_id: string; lot_number: string }>;
    const lotA = lots.find((l) => l.lot_number === CRL_LOT_A);
    const lotB = lots.find((l) => l.lot_number === CRL_LOT_B);
    expect(lotA).toBeDefined();
    expect(lotB).toBeDefined();

    await adminApi.dispose();

    // Step 3: Get the motion IDs using the voter's browser session cookie.
    // page.request shares the browser's cookie jar (which has the voter session cookie
    // set by the auth endpoint), so these API calls authenticate correctly.
    const motionsRes = await page.request.get(`/api/general-meeting/${crlMeetingId}/motions`);
    expect(motionsRes.ok(), `get motions: ${motionsRes.status()} ${await motionsRes.text()}`).toBe(true);
    const motionsData = (await motionsRes.json()) as Array<{ id: string }>;
    expect(motionsData.length).toBeGreaterThan(0);
    const motionId = motionsData[0].id;

    // Step 4: Submit Lot A's ballot via the voter API using the browser's session cookie.
    // Accept 201 (success) or 409 (already submitted — can happen on retry when the
    // previous attempt submitted successfully before the assertion failed).
    const submitRes = await page.request.post(`/api/general-meeting/${crlMeetingId}/submit`, {
      data: {
        lot_owner_ids: [lotA!.lot_owner_id],
        votes: [{ motion_id: motionId, choice: "yes" }],
      },
    });
    const submitStatus = submitRes.status();
    expect(
      submitStatus === 201 || submitStatus === 200 || submitStatus === 409,
      `submit ballot: expected 201/200/409, got ${submitStatus} ${await submitRes.text()}`
    ).toBe(true);

    // Step 4b: Update sessionStorage to reflect the submitted state for Lot A.
    // Normally the React onSuccess handler does this, but since we submitted via API
    // directly (not through the UI), we must manually update the cached lot info so
    // that VotingPage shows the correct "Already submitted" badge when we navigate back.
    await page.evaluate(
      ([id, lotAId, motionIdVal]) => {
        const key = `meeting_lots_info_${id}`;
        const raw = sessionStorage.getItem(key);
        if (!raw) return;
        try {
          const lots = JSON.parse(raw) as Array<{ lot_owner_id: string; already_submitted: boolean; voted_motion_ids: string[] }>;
          const updated = lots.map((l) =>
            l.lot_owner_id === lotAId
              ? { ...l, already_submitted: true, voted_motion_ids: [motionIdVal] }
              : l
          );
          sessionStorage.setItem(key, JSON.stringify(updated));
        } catch {
          // ignore
        }
      },
      [crlMeetingId, lotA!.lot_owner_id, motionId]
    );

    // Step 5: Navigate to the confirmation page directly (session already active in the browser).
    await page.goto(`/vote/${crlMeetingId}/confirmation`);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // "Vote for remaining lots" button must be visible (Lot B not yet submitted)
    await expect(page.getByRole("button", { name: "Vote for remaining lots" })).toBeVisible({ timeout: 15000 });

    // Step 6: Click "Vote for remaining lots" — navigate back to /voting
    await page.getByRole("button", { name: "Vote for remaining lots" }).click();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });
    await page.waitForLoadState("networkidle");

    // Lot A must show "Already submitted" badge.
    // Scope to the accessibility tree using the lot item text to avoid matching
    // both the desktop sidebar and the mobile drawer (which is aria-hidden when closed).
    const lotAItem = page.getByRole("listitem").filter({ hasText: `Lot ${CRL_LOT_A}` }).first();
    await expect(lotAItem.getByText("Already submitted")).toBeVisible({ timeout: 15000 });
    const lotACheckbox = lotAItem.getByRole("checkbox");
    await expect(lotACheckbox).toBeDisabled();

    // Lot B must still be selectable (not submitted)
    const lotBItem = page.getByRole("listitem").filter({ hasText: `Lot ${CRL_LOT_B}` }).first();
    const lotBCheckboxAfter = lotBItem.getByRole("checkbox");
    await expect(lotBCheckboxAfter).not.toBeDisabled();
    await expect(lotBCheckboxAfter).toBeChecked();
  });
});
