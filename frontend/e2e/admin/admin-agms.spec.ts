import { test, expect } from "@playwright/test";

test.describe("Admin AGMs", () => {
  test("navigates to AGMs page via sidebar", async ({ page }) => {
    await page.goto("/admin/agms");
    await expect(page.getByText("Admin Portal")).toBeVisible();
    await expect(page.getByRole("link", { name: "AGMs" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AGMs" })).toBeVisible();
  });

  test("displays AGM table with data", async ({ page }) => {
    await page.goto("/admin/agms");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("Building")).toBeVisible();
    await expect(page.getByText("Title")).toBeVisible();
    await expect(page.getByText("Status")).toBeVisible();
  });

  test("clicking Create AGM navigates to create form", async ({ page }) => {
    await page.goto("/admin/agms");
    await page.getByRole("button", { name: "Create AGM" }).click();
    await expect(page).toHaveURL(/\/admin\/agms\/new/);
  });

  test("create AGM form: fill fields and add motion, submit navigates to detail", async ({
    page,
    request,
  }) => {
    // Seed: ensure at least one building exists
    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string; name: string }[];
    expect(buildings.length).toBeGreaterThan(0);

    await page.goto("/admin/agms/new");
    await expect(page.getByRole("heading", { name: /Create AGM/ })).toBeVisible();

    // Fill building selection
    await page.getByLabel("Building").selectOption({ index: 0 });

    // Fill title
    await page.getByLabel("Title").fill("E2E Test AGM");

    // Fill meeting datetime
    const meetingAt = page.getByLabel("Meeting date/time");
    await meetingAt.fill("2025-06-01T10:00");

    // Fill voting closes datetime
    const votingClosesAt = page.getByLabel("Voting closes");
    await votingClosesAt.fill("2025-06-08T10:00");

    // Add a motion
    await page.getByRole("button", { name: "Add Motion" }).click();
    await page.getByLabel("Motion 1 Title").fill("Test Motion 1");
    await page.getByLabel("Motion 1 Description").fill("A test motion description");

    // Submit form
    await page.getByRole("button", { name: "Create AGM" }).click();

    // Should navigate to AGM detail page
    await expect(page).toHaveURL(/\/admin\/agms\/[^/]+$/);
  });

  test("AGM detail page shows title and status badge", async ({ page, request }) => {
    // Get an existing AGM
    const agmsRes = await request.get("/api/admin/agms");
    const agms = await agmsRes.json() as { id: string; title: string; status: string }[];
    const agm = agms[0];
    expect(agm).toBeDefined();

    await page.goto(`/admin/agms/${agm.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Status badge should be visible (either Open or Closed)
    const badge = page.getByText(/^(Open|Closed)$/);
    await expect(badge).toBeVisible();
  });

  test("AGM detail page shows eligible voters and submitted counts", async ({
    page,
    request,
  }) => {
    const agmsRes = await request.get("/api/admin/agms");
    const agms = await agmsRes.json() as { id: string }[];
    const agm = agms[0];

    await page.goto(`/admin/agms/${agm.id}`);
    await expect(page.getByText(/Eligible voters:/)).toBeVisible();
    await expect(page.getByText(/Submitted:/)).toBeVisible();
  });

  test("open AGM shows Close Voting button", async ({ page, request }) => {
    const agmsRes = await request.get("/api/admin/agms");
    const agms = await agmsRes.json() as { id: string; status: string }[];
    const openAgm = agms.find((a) => a.status === "open");

    if (!openAgm) {
      test.skip();
      return;
    }

    await page.goto(`/admin/agms/${openAgm.id}`);
    await expect(page.getByRole("button", { name: "Close Voting" })).toBeVisible();
  });

  test("Close Voting shows confirmation dialog", async ({ page, request }) => {
    const agmsRes = await request.get("/api/admin/agms");
    const agms = await agmsRes.json() as { id: string; status: string }[];
    const openAgm = agms.find((a) => a.status === "open");

    if (!openAgm) {
      test.skip();
      return;
    }

    await page.goto(`/admin/agms/${openAgm.id}`);
    await page.getByRole("button", { name: "Close Voting" }).click();
    await expect(page.getByText(/This cannot be undone/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm Close" })).toBeVisible();
  });

  test("closed AGM does not show Close Voting button", async ({ page, request }) => {
    const agmsRes = await request.get("/api/admin/agms");
    const agms = await agmsRes.json() as { id: string; status: string }[];
    const closedAgm = agms.find((a) => a.status === "closed");

    if (!closedAgm) {
      test.skip();
      return;
    }

    await page.goto(`/admin/agms/${closedAgm.id}`);
    await expect(page.getByRole("button", { name: "Close Voting" })).not.toBeVisible();
  });

  test("AGM detail page shows Results Report section", async ({ page, request }) => {
    const agmsRes = await request.get("/api/admin/agms");
    const agms = await agmsRes.json() as { id: string }[];
    const agm = agms[0];

    await page.goto(`/admin/agms/${agm.id}`);
    await expect(page.getByRole("heading", { name: "Results Report" })).toBeVisible();
  });

  test("clicking AGM row in list navigates to AGM detail", async ({ page }) => {
    await page.goto("/admin/agms");
    const firstRow = page.getByRole("row").nth(1);
    await firstRow.click();
    await expect(page).toHaveURL(/\/admin\/agms\/[^/]+$/);
  });
});
