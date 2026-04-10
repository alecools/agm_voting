/**
 * Functional test: proxy voter journey — badge verification.
 *
 * Test 1 (proxy-only voter flow) has been retired — it is superseded by WF6
 * in e2e/workflows/voting-scenarios.spec.ts, which additionally verifies exact
 * tally numbers using the lot owner's entitlement (not the proxy voter's).
 *
 * Test 3 (proxy-only auth isolation) has been retired — it is superseded by
 * WF6 in e2e/workflows/voting-scenarios.spec.ts.
 *
 * Remaining tests:
 *
 * 2. A mixed voter (own lots + proxied lots) sees all lots, with correct
 *    badges, and can vote for all of them.
 *
 * Self-contained — seeds its own building, lot owners, proxy nominations, and
 * AGM via the admin API so it does not interfere with other E2E tests.
 */

import { test, expect, RUN_SUFFIX } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { getTestOtp, makeAdminApi } from "./workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Scenario 2: mixed voter (own lot + proxy lot) ─────────────────────────────
const MIXED_BUILDING_NAME = `E2E Mixed Proxy Test Building-${RUN_SUFFIX}`;
const MIXED_LOT_A_NUMBER = "MX-A";
const MIXED_LOT_A_OWNER_EMAIL = "mixed-voter@test.com"; // owns MX-A directly
const MIXED_LOT_C_NUMBER = "MX-C";
const MIXED_LOT_C_OWNER_EMAIL = "lotC-owner@test.com"; // MX-C proxied to mixed-voter
const MIXED_AGM_TITLE = `E2E Mixed Proxy Test AGM-${RUN_SUFFIX}`;

/** Upload a CSV as multipart/form-data to the import-proxies endpoint. */
async function uploadProxyCsv(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  buildingId: string,
  csvContent: string
): Promise<void> {
  const res = await api.post(
    `/api/admin/buildings/${buildingId}/lot-owners/import-proxies`,
    {
      multipart: {
        file: {
          name: "proxies.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(csvContent),
        },
      },
    }
  );
  if (!res.ok()) {
    throw new Error(
      `Proxy import failed (${res.status()}): ${await res.text()}`
    );
  }
}

test.describe("Proxy voter journey", () => {
  // Serial mode prevents parallel workers from each running their own beforeAll,
  // which would cause multiple concurrent Lambda cold starts and timeout races.
  test.describe.configure({ mode: "serial" });

  // Shared IDs populated in beforeAll
  let mixedBuildingId = "";
  let mixedAgmId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await makeAdminApi(baseURL);

    // ── Seed Scenario 2 data: mixed voter building ──────────────────────────
    const buildingsRes = await api.get(`/api/admin/buildings?name=${encodeURIComponent(MIXED_BUILDING_NAME)}`);
    if (!buildingsRes.ok()) throw new Error(`GET /api/admin/buildings returned ${buildingsRes.status()}: ${await buildingsRes.text()}`);
    const buildings = (await buildingsRes.json()) as {
      id: string;
      name: string;
    }[];
    let building = buildings.find((b) => b.name === MIXED_BUILDING_NAME);
    if (!building) {
      const res = await api.post("/api/admin/buildings", {
        data: {
          name: MIXED_BUILDING_NAME,
          manager_email: "mixed-mgr@test.com",
        },
      });
      building = (await res.json()) as { id: string; name: string };
    }
    mixedBuildingId = building.id;

    const lotOwnersRes = await api.get(
      `/api/admin/buildings/${mixedBuildingId}/lot-owners`
    );
    const lotOwners = (await lotOwnersRes.json()) as {
      id: string;
      lot_number: string;
      emails: string[];
    }[];

    // MX-A: owned directly by mixed-voter@test.com
    let mxA = lotOwners.find((l) => l.lot_number === MIXED_LOT_A_NUMBER);
    if (!mxA) {
      const res = await api.post(
        `/api/admin/buildings/${mixedBuildingId}/lot-owners`,
        {
          data: {
            lot_number: MIXED_LOT_A_NUMBER,
            emails: [MIXED_LOT_A_OWNER_EMAIL],
            unit_entitlement: 15,
          },
        }
      );
      mxA = (await res.json()) as {
        id: string;
        lot_number: string;
        emails: string[];
      };
    } else if (!mxA.emails?.includes(MIXED_LOT_A_OWNER_EMAIL)) {
      await api.post(`/api/admin/lot-owners/${mxA.id}/emails`, {
        data: { email: MIXED_LOT_A_OWNER_EMAIL },
      });
    }

    // MX-C: owned by lotC-owner, proxied to mixed-voter@test.com
    let mxC = lotOwners.find((l) => l.lot_number === MIXED_LOT_C_NUMBER);
    if (!mxC) {
      const res = await api.post(
        `/api/admin/buildings/${mixedBuildingId}/lot-owners`,
        {
          data: {
            lot_number: MIXED_LOT_C_NUMBER,
            emails: [MIXED_LOT_C_OWNER_EMAIL],
            unit_entitlement: 25,
          },
        }
      );
      mxC = (await res.json()) as {
        id: string;
        lot_number: string;
        emails: string[];
      };
    } else if (!mxC.emails?.includes(MIXED_LOT_C_OWNER_EMAIL)) {
      await api.post(`/api/admin/lot-owners/${mxC.id}/emails`, {
        data: { email: MIXED_LOT_C_OWNER_EMAIL },
      });
    }

    const proxyCsv = `Lot#,Proxy Email\n${MIXED_LOT_C_NUMBER},${MIXED_LOT_A_OWNER_EMAIL}\n`;
    await uploadProxyCsv(api, mixedBuildingId, proxyCsv);

    const agmsRes = await api.get("/api/admin/general-meetings?limit=1000");
    const agms = (await agmsRes.json()) as {
      id: string;
      status: string;
      building_id: string;
    }[];
    const openAgms = agms.filter(
      (a) =>
        a.building_id === mixedBuildingId &&
        (a.status === "open" || a.status === "pending")
    );
    for (const agm of openAgms) {
      await api.post(`/api/admin/general-meetings/${agm.id}/close`);
    }

    const meetingStarted = new Date();
    meetingStarted.setHours(meetingStarted.getHours() - 1);
    const closesAt = new Date();
    closesAt.setFullYear(closesAt.getFullYear() + 1);

    const createRes = await api.post("/api/admin/general-meetings", {
      data: {
        building_id: mixedBuildingId,
        title: MIXED_AGM_TITLE,
        meeting_at: meetingStarted.toISOString(),
        voting_closes_at: closesAt.toISOString(),
        motions: [
          {
            title: "Mixed Proxy Test Motion — Bylaw",
            description: "Do you approve the bylaw change?",
            display_order: 1,
            motion_type: "general",
          },
        ],
      },
    });
    const newAgm = (await createRes.json()) as { id: string };
    mixedAgmId = newAgm.id;
    await api.delete(`/api/admin/general-meetings/${newAgm.id}/ballots`);
    await api.dispose();
  });

  // ── Test 2: mixed voter (own lot + proxy lot) ──────────────────────────────
  test(
    "mixed voter: sees own lot (no proxy badge) and proxied lot (proxy badge), votes both",
    async ({ page }) => {
      test.setTimeout(120000);

      // Clear any stale ballots from previous runs so auth always lands on lot-selection
      if (mixedAgmId) {
        const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
        const api = await playwrightRequest.newContext({
          baseURL,
          ignoreHTTPSErrors: true,
          storageState: path.join(__dirname, ".auth", "admin.json"),
          // 60s: get_db retries for up to ~55s under pool pressure; 30s default is too short
          timeout: 60000,
        });
        await api.delete(`/api/admin/general-meetings/${mixedAgmId}/ballots`);
        await api.dispose();
      }

      await page.goto("/");

      // Select the mixed-proxy building
      const select = page.getByLabel("Select your building");
      await expect(select).toBeVisible();
      await select.selectOption({ label: MIXED_BUILDING_NAME });

      await expect(
        page.getByRole("button", { name: "Enter Voting" }).first()
      ).toBeVisible({ timeout: 15000 });
      await page.getByRole("button", { name: "Enter Voting" }).first().click();

      // Auth as mixed-voter (owns MX-A, also proxied for MX-C) — OTP flow
      {
        const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
        const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: path.join(__dirname, ".auth", "admin.json"), timeout: 60000});
        await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });
        await page.getByLabel("Email address").fill(MIXED_LOT_A_OWNER_EMAIL);
        await page.getByRole("button", { name: "Send Verification Code" }).click();
        await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
        const code = await getTestOtp(api, MIXED_LOT_A_OWNER_EMAIL, mixedAgmId);
        await page.getByLabel("Verification code").fill(code);
        await page.getByRole("button", { name: "Verify" }).click();
        await api.dispose();
      }

      await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, {
        timeout: 20000,
      });

      if (page.url().includes("/voting") && !page.url().includes("/confirmation")) {
        // ── Lot panel assertions (top of VotingPage for proxy/multi-lot voters) ──

        // Both lots must be listed (scoped to sidebar to avoid mobile drawer duplicate)
        const lotItems = page.locator(".voting-layout__sidebar .lot-selection__item");
        await expect(lotItems).toHaveCount(2);

        // MX-A: own lot — no proxy badge
        const mxAItem = lotItems.filter({ hasText: `Lot ${MIXED_LOT_A_NUMBER}` });
        await expect(mxAItem).toBeVisible();
        await expect(
          mxAItem.locator(".lot-selection__badge--proxy")
        ).not.toBeVisible();

        // MX-C: proxy lot — proxy badge shows "via Proxy" (not "LOT MX-C VIA PROXY")
        const mxCItem = lotItems.filter({ hasText: `Lot ${MIXED_LOT_C_NUMBER}` });
        await expect(mxCItem).toBeVisible();
        const proxyCBadge = mxCItem.locator(".lot-selection__badge--proxy");
        await expect(proxyCBadge).toBeVisible();
        await expect(proxyCBadge).toContainText("via Proxy");
        await expect(proxyCBadge).not.toContainText(MIXED_LOT_C_NUMBER);

        // No "Start Voting" button — motions are immediately visible alongside sidebar
        await expect(page.getByRole("button", { name: "Start Voting" })).not.toBeVisible();
      }

      if (page.url().includes("/voting") && !page.url().includes("/confirmation")) {
        // Vote "Against" on the motion
        const motionCards = page.locator(".motion-card");
        await expect(motionCards).toHaveCount(1);

        await motionCards
          .first()
          .getByRole("button", { name: "Against" })
          .click();

        // Submit ballot
        await expect(
          page.getByRole("button", { name: "Submit ballot" })
        ).toBeVisible();
        await page.getByRole("button", { name: "Submit ballot" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "Submit ballot" }).last().click();

        await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
      }

      // ── Confirmation page ─────────────────────────────────────────────────
      await expect(
        page.getByText("Your votes", { exact: true })
      ).toBeVisible({ timeout: 15000 });

      // Multi-lot display: both lot numbers must appear
      await expect(
        page.getByText(`Lot ${MIXED_LOT_A_NUMBER}`, { exact: false }).first()
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByText(`Lot ${MIXED_LOT_C_NUMBER}`, { exact: false }).first()
      ).toBeVisible({ timeout: 10000 });

      // At least one "Against" vote recorded
      await expect(page.getByText("Against").first()).toBeVisible();
    }
  );

});
