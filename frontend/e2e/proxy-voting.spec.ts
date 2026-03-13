/**
 * Functional test: proxy voter journey.
 *
 * Verifies:
 * 1. A proxy-only voter (no direct lots) can authenticate, see their proxied
 *    lots with a "Proxy" badge, vote, and reach the confirmation page.
 * 2. A mixed voter (own lots + proxied lots) sees all lots, with correct
 *    badges, and can vote for all of them.
 * 3. A proxy-only voter's auth response only returns the proxied lots
 *    (backend does not include non-proxied lots).
 *
 * Self-contained — seeds its own building, lot owners, proxy nominations, and
 * AGM via the admin API so it does not interfere with other E2E tests.
 */

import { test, expect } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Scenario 1: proxy-only voter ─────────────────────────────────────────────
const PROXY_BUILDING_NAME = "E2E Proxy Test Building";
const LOT_A_NUMBER = "PX-A";
const LOT_A_OWNER_EMAIL = "lotA-owner@test.com";
const LOT_B_NUMBER = "PX-B";
const LOT_B_OWNER_EMAIL = "lotB-owner@test.com";
const PROXY_VOTER_EMAIL = "proxy-voter@test.com";
const PROXY_AGM_TITLE = "E2E Proxy Test AGM";

// ── Scenario 2: mixed voter (own lot + proxy lot) ─────────────────────────────
const MIXED_BUILDING_NAME = "E2E Mixed Proxy Test Building";
const MIXED_LOT_A_NUMBER = "MX-A";
const MIXED_LOT_A_OWNER_EMAIL = "mixed-voter@test.com"; // owns MX-A directly
const MIXED_LOT_C_NUMBER = "MX-C";
const MIXED_LOT_C_OWNER_EMAIL = "lotC-owner@test.com"; // MX-C proxied to mixed-voter
const MIXED_AGM_TITLE = "E2E Mixed Proxy Test AGM";

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

  // Shared lot-owner IDs populated in beforeAll
  let proxyBuildingId = "";
  let mixedBuildingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, ".auth", "admin.json"),
    });

    // ── Seed Scenario 1: proxy-only voter ────────────────────────────────────
    {
      // Create or find building
      const buildingsRes = await api.get("/api/admin/buildings");
      const buildings = (await buildingsRes.json()) as {
        id: string;
        name: string;
      }[];
      let building = buildings.find((b) => b.name === PROXY_BUILDING_NAME);
      if (!building) {
        const res = await api.post("/api/admin/buildings", {
          data: {
            name: PROXY_BUILDING_NAME,
            manager_email: "proxy-mgr@test.com",
          },
        });
        building = (await res.json()) as { id: string; name: string };
      }
      proxyBuildingId = building.id;

      // Create or find LOT-A (owned by lotA-owner@test.com)
      const lotOwnersRes = await api.get(
        `/api/admin/buildings/${proxyBuildingId}/lot-owners`
      );
      const lotOwners = (await lotOwnersRes.json()) as {
        id: string;
        lot_number: string;
        emails: string[];
      }[];

      let lotA = lotOwners.find((l) => l.lot_number === LOT_A_NUMBER);
      if (!lotA) {
        const res = await api.post(
          `/api/admin/buildings/${proxyBuildingId}/lot-owners`,
          {
            data: {
              lot_number: LOT_A_NUMBER,
              emails: [LOT_A_OWNER_EMAIL],
              unit_entitlement: 10,
            },
          }
        );
        lotA = (await res.json()) as {
          id: string;
          lot_number: string;
          emails: string[];
        };
      } else if (!lotA.emails?.includes(LOT_A_OWNER_EMAIL)) {
        await api.post(`/api/admin/lot-owners/${lotA.id}/emails`, {
          data: { email: LOT_A_OWNER_EMAIL },
        });
      }

      // Create or find LOT-B (owned by lotB-owner@test.com, proxied to proxy-voter)
      let lotB = lotOwners.find((l) => l.lot_number === LOT_B_NUMBER);
      if (!lotB) {
        const res = await api.post(
          `/api/admin/buildings/${proxyBuildingId}/lot-owners`,
          {
            data: {
              lot_number: LOT_B_NUMBER,
              emails: [LOT_B_OWNER_EMAIL],
              unit_entitlement: 20,
            },
          }
        );
        lotB = (await res.json()) as {
          id: string;
          lot_number: string;
          emails: string[];
        };
      } else if (!lotB.emails?.includes(LOT_B_OWNER_EMAIL)) {
        await api.post(`/api/admin/lot-owners/${lotB.id}/emails`, {
          data: { email: LOT_B_OWNER_EMAIL },
        });
      }

      // Upload proxy nomination: LOT-B proxied to proxy-voter@test.com
      const proxyCsv = `Lot#,Proxy Email\n${LOT_B_NUMBER},${PROXY_VOTER_EMAIL}\n`;
      await uploadProxyCsv(api, proxyBuildingId, proxyCsv);

      // Close any open AGMs for this building, then create a fresh one
      const agmsRes = await api.get("/api/admin/general-meetings");
      const agms = (await agmsRes.json()) as {
        id: string;
        status: string;
        building_id: string;
      }[];
      const openAgms = agms.filter(
        (a) =>
          a.building_id === proxyBuildingId &&
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
          building_id: proxyBuildingId,
          title: PROXY_AGM_TITLE,
          meeting_at: meetingStarted.toISOString(),
          voting_closes_at: closesAt.toISOString(),
          motions: [
            {
              title: "Proxy Test Motion — Budget Approval",
              description: "Do you approve the proxy test budget?",
              order_index: 1,
              motion_type: "general",
            },
          ],
        },
      });
      const newAgm = (await createRes.json()) as { id: string };
      await api.delete(`/api/admin/general-meetings/${newAgm.id}/ballots`);
    }

    // ── Seed Scenario 2: mixed voter ─────────────────────────────────────────
    {
      const buildingsRes = await api.get("/api/admin/buildings");
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

      // Upload proxy nomination: MX-C proxied to mixed-voter@test.com
      const proxyCsv = `Lot#,Proxy Email\n${MIXED_LOT_C_NUMBER},${MIXED_LOT_A_OWNER_EMAIL}\n`;
      await uploadProxyCsv(api, mixedBuildingId, proxyCsv);

      // Close existing AGMs and create a fresh one
      const agmsRes = await api.get("/api/admin/general-meetings");
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
              order_index: 1,
              motion_type: "general",
            },
          ],
        },
      });
      const newAgm = (await createRes.json()) as { id: string };
      await api.delete(`/api/admin/general-meetings/${newAgm.id}/ballots`);
    }

    await api.dispose();
  }, { timeout: 60000 }); // 60s timeout for API setup

  // ── Test 1: proxy-only voter journey ───────────────────────────────────────
  test(
    "proxy-only voter: sees proxy lot with badge, votes, reaches confirmation",
    async ({ page }) => {
      test.setTimeout(120000);
      await page.goto("/");

      // Select the proxy test building
      const select = page.getByLabel("Select your building");
      await expect(select).toBeVisible();
      await select.selectOption({ label: PROXY_BUILDING_NAME });

      // Enter the AGM voting flow
      await expect(
        page.getByRole("button", { name: "Enter Voting" }).first()
      ).toBeVisible({ timeout: 15000 });
      await page.getByRole("button", { name: "Enter Voting" }).first().click();

      // Auth as proxy voter (no direct lot — use LOT-B number which is what the UI asks for)
      await expect(page.getByLabel("Lot number")).toBeVisible();
      await expect(page.getByText(PROXY_BUILDING_NAME)).toBeVisible({
        timeout: 15000,
      });
      // The auth page asks for lot number + email. Proxy voters enter the proxied lot's number.
      await page.getByLabel("Lot number").fill(LOT_B_NUMBER);
      await page.getByLabel("Email address").fill(PROXY_VOTER_EMAIL);
      await page.getByRole("button", { name: "Continue" }).click();

      // Should land on lot-selection or confirmation
      await expect(page).toHaveURL(/vote\/.*\/(lot-selection|confirmation)/, {
        timeout: 20000,
      });

      if (page.url().includes("/lot-selection")) {
        // ── Lot selection assertions ──────────────────────────────────────────

        // Only LOT-B should be listed (proxy voter has no direct lots)
        const lotItems = page.locator(".lot-selection__item");
        await expect(lotItems).toHaveCount(1);

        // The single lot shows Lot PX-B
        await expect(lotItems.first()).toContainText(LOT_B_NUMBER);

        // LOT-B must have the "Proxy" badge
        const proxyBadge = lotItems
          .first()
          .locator(".lot-selection__badge--proxy");
        await expect(proxyBadge).toBeVisible();
        await expect(proxyBadge).toContainText("Proxy");

        // LOT-A must NOT be listed (proxy voter does not own it and is not proxied for it)
        await expect(page.getByText(`Lot ${LOT_A_NUMBER}`)).not.toBeVisible();

        // Proceed to voting
        await page.getByRole("button", { name: "Start Voting" }).click();
        await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });
      }

      if (page.url().includes("/voting")) {
        // Vote "For" on the motion
        const motionCards = page.locator(".motion-card");
        await expect(motionCards).toHaveCount(1);

        await motionCards
          .first()
          .getByRole("button", { name: "For" })
          .click();

        // Submit ballot
        await expect(
          page.getByRole("button", { name: "Submit ballot" })
        ).toBeVisible();
        await page.getByRole("button", { name: "Submit ballot" }).click();
        // Confirm in the dialog
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "Submit ballot" }).last().click();

        await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
      }

      // ── Confirmation page ─────────────────────────────────────────────────
      await expect(
        page.getByText("Your votes", { exact: true })
      ).toBeVisible({ timeout: 15000 });

      // The motion vote should show "For"
      await expect(page.getByText("For").first()).toBeVisible();
    }
  );

  // ── Test 2: mixed voter (own lot + proxy lot) ──────────────────────────────
  test(
    "mixed voter: sees own lot (no proxy badge) and proxied lot (proxy badge), votes both",
    async ({ page }) => {
      test.setTimeout(120000);
      await page.goto("/");

      // Select the mixed-proxy building
      const select = page.getByLabel("Select your building");
      await expect(select).toBeVisible();
      await select.selectOption({ label: MIXED_BUILDING_NAME });

      await expect(
        page.getByRole("button", { name: "Enter Voting" }).first()
      ).toBeVisible({ timeout: 15000 });
      await page.getByRole("button", { name: "Enter Voting" }).first().click();

      // Auth as mixed-voter (owns MX-A, also proxied for MX-C)
      await expect(page.getByLabel("Lot number")).toBeVisible();
      await expect(page.getByText(MIXED_BUILDING_NAME)).toBeVisible({
        timeout: 15000,
      });
      await page.getByLabel("Lot number").fill(MIXED_LOT_A_NUMBER);
      await page.getByLabel("Email address").fill(MIXED_LOT_A_OWNER_EMAIL);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page).toHaveURL(/vote\/.*\/(lot-selection|confirmation)/, {
        timeout: 20000,
      });

      if (page.url().includes("/lot-selection")) {
        // ── Lot selection assertions ──────────────────────────────────────────

        // Both lots must be listed
        const lotItems = page.locator(".lot-selection__item");
        await expect(lotItems).toHaveCount(2);

        // MX-A: own lot — no proxy badge
        const mxAItem = lotItems.filter({ hasText: `Lot ${MIXED_LOT_A_NUMBER}` });
        await expect(mxAItem).toBeVisible();
        await expect(
          mxAItem.locator(".lot-selection__badge--proxy")
        ).not.toBeVisible();

        // MX-C: proxy lot — proxy badge visible
        const mxCItem = lotItems.filter({ hasText: `Lot ${MIXED_LOT_C_NUMBER}` });
        await expect(mxCItem).toBeVisible();
        const proxyCBadge = mxCItem.locator(".lot-selection__badge--proxy");
        await expect(proxyCBadge).toBeVisible();
        await expect(proxyCBadge).toContainText("Proxy");

        // Proceed to voting
        await page.getByRole("button", { name: "Start Voting" }).click();
        await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });
      }

      if (page.url().includes("/voting")) {
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

  // ── Test 3: proxy-only auth response contains only proxied lots ────────────
  test(
    "auth API: proxy-only voter's response contains only the proxied lot, not un-proxied lots",
    async ({ page }) => {
      test.setTimeout(60000);

      // We verify this via the UI: after authenticating as proxy-voter@test.com
      // for the proxy building, the lot selection page shows only LOT-B (not LOT-A).
      await page.goto("/");

      const select = page.getByLabel("Select your building");
      await expect(select).toBeVisible();
      await select.selectOption({ label: PROXY_BUILDING_NAME });

      await expect(
        page.getByRole("button", { name: "Enter Voting" }).first()
      ).toBeVisible({ timeout: 15000 });
      await page.getByRole("button", { name: "Enter Voting" }).first().click();

      await expect(page.getByLabel("Lot number")).toBeVisible();
      // Attempt to authenticate as proxy voter entering LOT-B (their proxied lot)
      await page.getByLabel("Lot number").fill(LOT_B_NUMBER);
      await page.getByLabel("Email address").fill(PROXY_VOTER_EMAIL);
      await page.getByRole("button", { name: "Continue" }).click();

      // Should be redirected to lot-selection or confirmation (not stuck on auth page with error)
      await expect(page).toHaveURL(/vote\/.*\/(lot-selection|confirmation)/, {
        timeout: 20000,
      });

      if (page.url().includes("/lot-selection")) {
        // LOT-A must NOT be visible — proxy voter is not proxied for LOT-A
        await expect(page.getByText(`Lot ${LOT_A_NUMBER}`)).not.toBeVisible();

        // LOT-B must be visible with proxy badge
        await expect(page.getByText(`Lot ${LOT_B_NUMBER}`)).toBeVisible();
        await expect(
          page.locator(".lot-selection__badge--proxy").first()
        ).toBeVisible();
      }
    }
  );
});
