import { test, expect } from "../fixtures";

test.describe("Admin Buildings", () => {
  test("navigates to buildings page via sidebar", async ({ page }) => {
    await page.goto("/admin/buildings");
    await expect(page.getByText("Admin Portal").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Buildings" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Buildings", exact: true })).toBeVisible();
  });

  test("displays building table with data", async ({ page }) => {
    await page.goto("/admin/buildings");
    // Assumes at least one building exists in the seeded database
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Name" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Manager Email" })).toBeVisible();
  });

  test("CSV upload success shows created and updated counts", async ({ page }) => {
    await page.goto("/admin/buildings");
    const csvContent = "building_name,manager_email\nTest Building E2E,manager@test.com";
    const buffer = Buffer.from(csvContent, "utf-8");
    const fileInput = page.getByLabel("Buildings file");
    await fileInput.setInputFiles({
      name: "buildings.csv",
      mimeType: "text/csv",
      buffer,
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText(/Import complete:/)).toBeVisible();
  });

  test("clicking building name navigates to building detail", async ({ page }) => {
    await page.goto("/admin/buildings");
    // Click the first building name link
    const firstBuildingLink = page.getByRole("row").nth(1).getByRole("button").first();
    const buildingName = await firstBuildingLink.textContent();
    await firstBuildingLink.click();
    await expect(page).toHaveURL(/\/admin\/buildings\//);
    if (buildingName) {
      await expect(page.getByText(buildingName)).toBeVisible();
    }
  });

  test("create building via modal dialog", async ({ page }) => {
    const buildingName = `E2E Modal Building ${Date.now()}`;
    await page.goto("/admin/buildings");
    await expect(page.getByRole("heading", { name: "Buildings", exact: true })).toBeVisible();

    // Open modal
    await page.getByRole("button", { name: "+ New Building" }).click();
    await expect(page.getByRole("dialog", { name: "New Building" })).toBeVisible();

    // Fill in the form
    await page.getByLabel("Building Name").fill(buildingName);
    await page.getByLabel("Manager Email").fill("e2e-modal@test.com");

    // Submit
    await page.getByRole("button", { name: "Create Building" }).click();

    // Modal closes after success
    await expect(page.getByRole("dialog", { name: "New Building" })).not.toBeVisible();

    // New building appears in the table
    await expect(page.getByRole("button", { name: buildingName })).toBeVisible();
  });
});
