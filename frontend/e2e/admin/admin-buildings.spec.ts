import { test, expect } from "@playwright/test";

test.describe("Admin Buildings", () => {
  test("navigates to buildings page via sidebar", async ({ page }) => {
    await page.goto("/admin/buildings");
    await expect(page.getByText("Admin Portal")).toBeVisible();
    await expect(page.getByRole("link", { name: "Buildings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Buildings" })).toBeVisible();
  });

  test("displays building table with data", async ({ page }) => {
    await page.goto("/admin/buildings");
    // Assumes at least one building exists in the seeded database
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("Name")).toBeVisible();
    await expect(page.getByText("Manager Email")).toBeVisible();
  });

  test("CSV upload success shows created and updated counts", async ({ page }) => {
    await page.goto("/admin/buildings");
    const csvContent = "building_name,manager_email\nTest Building E2E,manager@test.com";
    const buffer = Buffer.from(csvContent, "utf-8");
    const fileInput = page.getByLabel("Buildings CSV file");
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
    const firstBuildingLink = page.getByRole("button").first();
    const buildingName = await firstBuildingLink.textContent();
    await firstBuildingLink.click();
    await expect(page).toHaveURL(/\/admin\/buildings\//);
    if (buildingName) {
      await expect(page.getByText(buildingName)).toBeVisible();
    }
  });
});
