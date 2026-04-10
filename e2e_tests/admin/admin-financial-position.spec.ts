/**
 * E2E test: TOCS CSV financial position upload.
 *
 * Creates a building, seeds lot owners for lots present in the TOCS CSV,
 * uploads the CSV via the admin UI, and asserts that:
 * - The success message appears
 * - At least one lot shows the "In Arrear" badge in the lot owners table
 *
 * Lot 5 is used because it carries a positive closing balance ($1,882.06)
 * in the Administrative Fund section → in_arrear after worst-case merge.
 * Lot 1 has $- (zero balance) → stays normal.
 *
 * Uses examples/Lot financial position.csv (lots 1–51, The Vale building).
 */

import { test, expect } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
} from "../workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the TOCS CSV file in the examples directory
const TOCS_CSV_PATH = path.resolve(
  __dirname,
  "../../examples/Lot financial position.csv"
);

const BUILDING_NAME = `AGM Financial Position Test Building-${Date.now()}`;

let buildingId = "";

test.describe("Admin — TOCS CSV financial position upload", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
      // 60s: get_db retries for up to ~55s under pool pressure; 30s default is too short
      timeout: 60000,
    });

    buildingId = await seedBuilding(api, BUILDING_NAME, "fin-pos-mgr@test.com");

    // Seed lot 5 — in arrear in TOCS CSV (positive closing balance $1,882.06)
    await seedLotOwner(api, buildingId, {
      lotNumber: "5",
      emails: ["fin-pos-5@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    // Seed lot 1 — normal in the CSV ($- zero balance)
    await seedLotOwner(api, buildingId, {
      lotNumber: "1",
      emails: ["fin-pos-1@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    await api.dispose();
  }, { timeout: 60000 });

  test("uploading TOCS CSV updates financial positions and shows success message", async ({
    page,
  }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });

    // Upload the TOCS CSV file via the hidden file input
    const fileInput = page.locator('input[aria-label="Financial positions file"]');
    await fileInput.setInputFiles(TOCS_CSV_PATH);

    // Success message appears
    await expect(
      page.getByText(/Import complete: \d+ updated, \d+ skipped\./i)
    ).toBeVisible({ timeout: 30000 });

    // Lot 5 should now show the "In Arrear" badge in the lot owners table
    await expect(
      page.getByRole("row").filter({ hasText: "5" }).getByText("In Arrear")
    ).toBeVisible({ timeout: 10000 });
  });

  // No afterAll cleanup needed — the building name includes a timestamp so
  // it won't conflict with future runs. There is no admin API endpoint for
  // deleting buildings.
});
