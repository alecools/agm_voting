import { test, expect } from "../fixtures";

test.describe("Admin General Meetings", () => {
  test("navigates to General Meetings page via sidebar", async ({ page }) => {
    await page.goto("/admin/general-meetings");
    await expect(page.getByText("Admin Portal")).toBeVisible();
    await expect(page.getByRole("link", { name: "General Meetings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "General Meetings" })).toBeVisible();
  });

  test("displays General Meeting table with data", async ({ page }) => {
    await page.goto("/admin/general-meetings");
    await expect(page.getByRole("table")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("columnheader", { name: "Building" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Title" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
  });

  test("clicking Create General Meeting navigates to create form", async ({ page }) => {
    await page.goto("/admin/general-meetings");
    await page.getByRole("button", { name: "Create General Meeting" }).click();
    await expect(page).toHaveURL(/\/admin\/general-meetings\/new/);
  });

  test("create General Meeting form: fill fields and add motion, submit navigates to detail", async ({
    page,
    request,
  }) => {
    // Seed: ensure at least one building exists
    const buildingsRes = await request.get("/api/admin/buildings");
    const buildings = await buildingsRes.json() as { id: string; name: string }[];
    expect(buildings.length).toBeGreaterThan(0);

    await page.goto("/admin/general-meetings/new");
    await expect(page.getByRole("heading", { name: /Create General Meeting/ })).toBeVisible();

    // Fill building selection
    await page.getByLabel("Building").selectOption({ index: 0 });

    // Fill title
    await page.locator("#agm-title").fill("E2E Test General Meeting");

    // Fill meeting datetime
    await page.locator("#agm-meeting-at").fill("2025-06-01T10:00");

    // Fill voting closes datetime
    await page.locator("#agm-voting-closes-at").fill("2025-06-08T10:00");

    // Fill first motion (already present by default)
    await page.locator("#motion-title-0").fill("Test Motion 1");
    await page.locator("#motion-desc-0").fill("A test motion description");

    // Submit form
    await page.getByRole("button", { name: "Create General Meeting" }).click();

    // Should navigate to General Meeting detail page
    await expect(page).toHaveURL(/\/admin\/general-meetings\/[^/]+$/);
  });

  test("General Meeting detail page shows title and status badge", async ({ page, request }) => {
    // Get an existing General Meeting
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string; title: string; status: string }[];
    const meeting = meetings[0];
    expect(meeting).toBeDefined();

    await page.goto(`/admin/general-meetings/${meeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    // Status badge should be visible (either Open or Closed)
    const badge = page.getByText(/^(Open|Closed)$/);
    await expect(badge).toBeVisible({ timeout: 10000 });
  });

  test("General Meeting detail page shows eligible voters and submitted counts", async ({
    page,
    request,
  }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string }[];
    const meeting = meetings[0];

    await page.goto(`/admin/general-meetings/${meeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Eligible voters")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Submitted")).toBeVisible({ timeout: 5000 });
  });

  test("open General Meeting shows Close Voting button", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const openMeeting = meetings.find((a) => a.status === "open");

    if (!openMeeting) {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${openMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Close Voting" })).toBeVisible({ timeout: 10000 });
  });

  test("Close Voting shows confirmation dialog", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const openMeeting = meetings.find((a) => a.status === "open");

    if (!openMeeting) {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${openMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Close Voting" }).click();
    await expect(page.getByText(/This cannot be undone/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Confirm Close" })).toBeVisible();
  });

  test("closed General Meeting does not show Close Voting button", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const closedMeeting = meetings.find((a) => a.status === "closed");

    if (!closedMeeting) {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${closedMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Close Voting" })).not.toBeVisible();
  });

  test("General Meeting detail page shows Results Report section", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string }[];
    const meeting = meetings[0];

    await page.goto(`/admin/general-meetings/${meeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Results Report" })).toBeVisible({ timeout: 10000 });
  });

  test("clicking General Meeting row in list navigates to detail", async ({ page }) => {
    await page.goto("/admin/general-meetings");
    const firstRow = page.getByRole("row").nth(1);
    await firstRow.click();
    await expect(page).toHaveURL(/\/admin\/general-meetings\/[^/]+$/);
  });
});
