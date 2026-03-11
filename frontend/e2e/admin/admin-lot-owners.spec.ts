import { test, expect } from "../fixtures";

// Serial: the "CSV import" test replaces all lot owners, which would race with
// "add lot owner" if they ran in parallel on the same E2E Building.
test.describe.serial("Admin Lot Owners", () => {
  // Note: Requires a building to exist. Seed via API before tests.

  test("displays lot owner table for a building", async ({ page, request }) => {
    // Seed: create a building and lot owners via API
    const buildingRes = await request.post("/api/admin/buildings/import", {
      multipart: {
        file: {
          name: "buildings.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("building_name,manager_email\nE2E Building,manager@e2e.com"),
        },
      },
    });
    expect(buildingRes.ok()).toBeTruthy();

    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string; name: string }[];
    const building = buildings.find((b) => b.name === "E2E Building");
    expect(building).toBeDefined();

    await page.goto(`/admin/buildings/${building!.id}`);
    await expect(page.getByText("E2E Building")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: /E2E Building/ })).toBeVisible();
  });

  test("add lot owner form submits and shows in table", async ({ page, request }) => {
    // Ensure the dedicated E2E Building exists (same seed used by "displays lot owner table")
    await request.post("/api/admin/buildings/import", {
      multipart: {
        file: {
          name: "buildings.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("building_name,manager_email\nE2E Building,manager@e2e.com"),
        },
      },
    });
    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string; name: string }[];
    const building = buildings.find((b) => b.name === "E2E Building")!;

    const uniqueLot = `E2E-LOT-${Date.now()}`;
    await page.goto(`/admin/buildings/${building.id}`);
    // Wait for the building page to finish loading before interacting
    await expect(page.getByRole("heading", { name: /E2E Building/ })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Add Lot Owner" }).click();
    await page.getByLabel("Lot Number").fill(uniqueLot);
    await page.getByLabel("Email").fill("lot1@e2e.com");
    await page.getByLabel("Unit Entitlement").fill("50");
    await page.getByRole("button", { name: "Add Lot Owner" }).last().click();

    await expect(page.getByText(uniqueLot)).toBeVisible({ timeout: 15000 });
  });

  test("CSV import shows imported count", async ({ page, request }) => {
    // Ensure the dedicated E2E Building exists before importing lot owners into it
    await request.post("/api/admin/buildings/import", {
      multipart: {
        file: {
          name: "buildings.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("building_name,manager_email\nE2E Building,manager@e2e.com"),
        },
      },
    });
    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string; name: string }[];
    const building = buildings.find((b) => b.name === "E2E Building")!;

    await page.goto(`/admin/buildings/${building.id}`);
    // Wait for the building page to finish loading before interacting
    await expect(page.getByRole("heading", { name: /E2E Building/ })).toBeVisible({ timeout: 15000 });
    const csvContent =
      "lot_number,email,unit_entitlement\nLOT-A,a@e2e.com,100\nLOT-B,b@e2e.com,200";
    const fileInput = page.getByLabel("Lot owners file");
    await fileInput.setInputFiles({
      name: "owners.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText(/Import complete: 2 records imported/)).toBeVisible();
  });
});
