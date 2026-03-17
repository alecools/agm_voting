/**
 * E2E test: TOCS xlsx financial position upload.
 *
 * Creates a building, seeds lot owners for lots present in the TOCS xlsx,
 * uploads the xlsx via the admin UI, and asserts that:
 * - The success message appears
 * - At least one lot shows the "In Arrear" badge in the lot owners table
 *
 * Lot 54 is used because it carries a positive closing balance in both
 * Administrative and Maintenance fund sections → in_arrear after worst-case merge.
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

// Path to the TOCS xlsx file in the examples directory
const TOCS_XLSX_PATH = path.resolve(
  __dirname,
  "../../../../examples/Consolidated Lot Positions Report 20-10-2025 to 17-03-2026.xlsx"
);

const BUILDING_NAME = `AGM Financial Position Test Building-${Date.now()}`;

let buildingId = "";

test.describe("Admin — TOCS xlsx financial position upload", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    buildingId = await seedBuilding(api, BUILDING_NAME, "fin-pos-mgr@test.com");

    // Seed lot 54 — in arrear in TOCS xlsx (positive closing balance in both fund sections)
    await seedLotOwner(api, buildingId, {
      lotNumber: "54",
      emails: ["fin-pos-54@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    // Seed a second lot that is normal in the xlsx (lot 53 has negative closing balance → normal)
    await seedLotOwner(api, buildingId, {
      lotNumber: "53",
      emails: ["fin-pos-53@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    await api.dispose();
  }, { timeout: 60000 });

  test("uploading TOCS xlsx updates financial positions and shows success message", async ({
    page,
  }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });

    // Upload the TOCS xlsx file via the hidden file input
    const fileInput = page.locator('input[aria-label="Financial positions file"]');
    await fileInput.setInputFiles(TOCS_XLSX_PATH);

    // Success message appears
    await expect(
      page.getByText(/Import complete: \d+ updated, \d+ skipped\./i)
    ).toBeVisible({ timeout: 30000 });

    // Lot 54 should now show the "In Arrear" badge in the lot owners table
    await expect(
      page.getByRole("row").filter({ hasText: "54" }).getByText("In Arrear")
    ).toBeVisible({ timeout: 10000 });
  });

  // No afterAll cleanup needed — the building name includes a timestamp so
  // it won't conflict with future runs. There is no admin API endpoint for
  // deleting buildings.
});
