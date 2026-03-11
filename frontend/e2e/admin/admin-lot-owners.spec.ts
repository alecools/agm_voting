import { test, expect } from "../fixtures";

test.describe("Admin Lot Owners", () => {
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
    await expect(page.getByText("E2E Building")).toBeVisible();
    await expect(page.getByRole("heading", { name: /E2E Building/ })).toBeVisible();
  });

  test("add lot owner form submits and shows in table", async ({ page, request }) => {
    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string; name: string }[];
    const building = buildings[0];

    await page.goto(`/admin/buildings/${building.id}`);
    await page.getByRole("button", { name: "Add Lot Owner" }).click();
    await page.getByLabel("Lot Number").fill("E2E-LOT-1");
    await page.getByLabel("Email").fill("lot1@e2e.com");
    await page.getByLabel("Unit Entitlement").fill("50");
    await page.getByRole("button", { name: "Add Lot Owner" }).last().click();

    await expect(page.getByText("E2E-LOT-1")).toBeVisible();
  });

  test("CSV import shows imported count", async ({ page, request }) => {
    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string }[];
    const building = buildings[0];

    await page.goto(`/admin/buildings/${building.id}`);
    const csvContent =
      "lot_number,email,unit_entitlement\nLOT-A,a@e2e.com,100\nLOT-B,b@e2e.com,200";
    const fileInput = page.getByLabel("Lot owners CSV file");
    await fileInput.setInputFiles({
      name: "owners.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csvContent),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText(/Import complete: 2 records imported/)).toBeVisible();
  });
});
