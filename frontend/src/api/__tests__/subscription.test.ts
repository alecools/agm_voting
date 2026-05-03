import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { getSubscription, updateSubscription, unarchiveBuilding } from "../subscription";

const BASE = "http://localhost";

const SUBSCRIPTION_FIXTURE = {
  tier_name: "Starter",
  building_limit: 10,
  active_building_count: 3,
};

describe("getSubscription", () => {
  // --- Happy path ---

  it("fetches and returns the subscription response", async () => {
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json(SUBSCRIPTION_FIXTURE)
      )
    );
    const result = await getSubscription();
    expect(result.tier_name).toBe("Starter");
    expect(result.building_limit).toBe(10);
    expect(result.active_building_count).toBe(3);
  });

  it("handles null tier_name and null building_limit (unlimited/no-plan)", async () => {
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    const result = await getSubscription();
    expect(result.tier_name).toBeNull();
    expect(result.building_limit).toBeNull();
    expect(result.active_building_count).toBe(0);
  });

  // --- Error cases ---

  it("throws on 403 Forbidden", async () => {
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "Forbidden" }, { status: 403 })
      )
    );
    await expect(getSubscription()).rejects.toThrow(/403/);
  });

  it("throws on 500 Internal Server Error", async () => {
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "Server error" }, { status: 500 })
      )
    );
    await expect(getSubscription()).rejects.toThrow(/500/);
  });
});

describe("updateSubscription", () => {
  // --- Happy path ---

  it("sends POST with tier_name and building_limit and returns updated response", async () => {
    server.use(
      http.post(`${BASE}/api/admin/subscription`, async ({ request }) => {
        const body = await request.json() as { tier_name: string; building_limit: number };
        expect(body.tier_name).toBe("Pro");
        expect(body.building_limit).toBe(20);
        return HttpResponse.json({ tier_name: "Pro", building_limit: 20, active_building_count: 5 });
      })
    );
    const result = await updateSubscription({ tier_name: "Pro", building_limit: 20 });
    expect(result.tier_name).toBe("Pro");
    expect(result.building_limit).toBe(20);
    expect(result.active_building_count).toBe(5);
  });

  it("sends null tier_name and null building_limit for unlimited/no-plan", async () => {
    server.use(
      http.post(`${BASE}/api/admin/subscription`, async ({ request }) => {
        const body = await request.json() as { tier_name: null; building_limit: null };
        expect(body.tier_name).toBeNull();
        expect(body.building_limit).toBeNull();
        return HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 10 });
      })
    );
    const result = await updateSubscription({ tier_name: null, building_limit: null });
    expect(result.tier_name).toBeNull();
    expect(result.building_limit).toBeNull();
  });

  // --- Error cases ---

  it("throws on 403 Forbidden (non-operator)", async () => {
    server.use(
      http.post(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "Operator access required" }, { status: 403 })
      )
    );
    await expect(
      updateSubscription({ tier_name: "Pro", building_limit: 10 })
    ).rejects.toThrow(/403/);
  });

  it("throws on 422 validation error", async () => {
    server.use(
      http.post(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "building_limit must be >= 1" }, { status: 422 })
      )
    );
    await expect(
      updateSubscription({ tier_name: "Bad", building_limit: -1 })
    ).rejects.toThrow(/422/);
  });
});

describe("unarchiveBuilding", () => {
  // --- Happy path ---

  it("sends POST to the unarchive endpoint and returns the unarchived building", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, ({ params }) => {
        expect(params.buildingId).toBe("b3");
        return HttpResponse.json({ id: "b3", name: "Gamma House", is_archived: false });
      })
    );
    const result = await unarchiveBuilding("b3");
    expect(result.id).toBe("b3");
    expect(result.is_archived).toBe(false);
  });

  it("includes the building ID in the URL path", async () => {
    let capturedId: string | readonly string[] | undefined;
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, ({ params }) => {
        capturedId = params.buildingId;
        return HttpResponse.json({ id: "b99", name: "Test Building", is_archived: false });
      })
    );
    await unarchiveBuilding("b99");
    expect(capturedId).toBe("b99");
  });

  // --- Error cases ---

  it("throws on 404 when building not found", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, () =>
        HttpResponse.json({ detail: "Building not found" }, { status: 404 })
      )
    );
    await expect(unarchiveBuilding("not-found-id")).rejects.toThrow(/404/);
  });

  it("throws on 403 Forbidden (non-operator)", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, () =>
        HttpResponse.json({ detail: "Operator access required" }, { status: 403 })
      )
    );
    await expect(unarchiveBuilding("b3")).rejects.toThrow(/403/);
  });
});
