import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import {
  getBuildingsCount,
  getGeneralMeetingsCount,
  listBuildings,
  listGeneralMeetings,
  deleteGeneralMeeting,
  deleteBuilding,
  deleteMotion,
  importBuildings,
  importLotOwners,
  importProxyNominations,
  importFinancialPositions,
} from "../admin";

const BASE = "http://localhost:8000";

describe("getBuildingsCount", () => {
  // --- Happy path ---

  it("returns count without any filter", async () => {
    server.use(
      http.get(`${BASE}/api/admin/buildings/count`, () =>
        HttpResponse.json({ count: 42 })
      )
    );
    const result = await getBuildingsCount();
    expect(result).toEqual({ count: 42 });
  });

  it("sends name query param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 3 });
      })
    );
    const result = await getBuildingsCount({ name: "Alpha" });
    expect(result).toEqual({ count: 3 });
    expect(capturedUrl).toContain("name=Alpha");
  });

  it("sends is_archived=false query param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 5 });
      })
    );
    await getBuildingsCount({ is_archived: false });
    expect(capturedUrl).toContain("is_archived=false");
  });

  it("sends is_archived=true query param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 2 });
      })
    );
    await getBuildingsCount({ is_archived: true });
    expect(capturedUrl).toContain("is_archived=true");
  });

  it("sends both name and is_archived params together", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 1 });
      })
    );
    await getBuildingsCount({ name: "Tower", is_archived: false });
    expect(capturedUrl).toContain("name=Tower");
    expect(capturedUrl).toContain("is_archived=false");
  });

  it("does not send params when not provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 10 });
      })
    );
    await getBuildingsCount(undefined);
    expect(capturedUrl).not.toContain("name");
    expect(capturedUrl).not.toContain("is_archived");
  });
});

describe("getGeneralMeetingsCount", () => {
  // --- Happy path ---

  it("returns count without filters", async () => {
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, () =>
        HttpResponse.json({ count: 7 })
      )
    );
    const result = await getGeneralMeetingsCount();
    expect(result).toEqual({ count: 7 });
  });

  it("sends name query param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 2 });
      })
    );
    await getGeneralMeetingsCount({ name: "AGM 2024" });
    expect(capturedUrl).toContain("name=AGM+2024");
  });

  it("sends building_id query param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 1 });
      })
    );
    await getGeneralMeetingsCount({ building_id: "b-123" });
    expect(capturedUrl).toContain("building_id=b-123");
  });

  it("sends both name and building_id params together", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 1 });
      })
    );
    await getGeneralMeetingsCount({ name: "AGM", building_id: "b-456" });
    expect(capturedUrl).toContain("name=AGM");
    expect(capturedUrl).toContain("building_id=b-456");
  });

  it("does not send params when not provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 5 });
      })
    );
    await getGeneralMeetingsCount({});
    expect(capturedUrl).not.toContain("name");
    expect(capturedUrl).not.toContain("building_id");
  });

  it("sends status query param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 3 });
      })
    );
    await getGeneralMeetingsCount({ status: "open" });
    expect(capturedUrl).toContain("status=open");
  });

  it("sends status, name, and building_id together", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ count: 1 });
      })
    );
    await getGeneralMeetingsCount({ status: "closed", name: "AGM", building_id: "b-1" });
    expect(capturedUrl).toContain("status=closed");
    expect(capturedUrl).toContain("name=AGM");
    expect(capturedUrl).toContain("building_id=b-1");
  });
});

describe("listBuildings with params", () => {
  // --- Happy path ---

  it("sends limit and offset params", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ limit: 20, offset: 40 });
    expect(capturedUrl).toContain("limit=20");
    expect(capturedUrl).toContain("offset=40");
  });

  it("sends name param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ name: "Tower" });
    expect(capturedUrl).toContain("name=Tower");
  });

  it("sends no query string when no params given", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings();
    expect(capturedUrl).not.toContain("?");
  });

  it("sends no query string when empty params object given", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({});
    expect(capturedUrl).not.toContain("?");
  });

  it("sends is_archived=false param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ is_archived: false });
    expect(capturedUrl).toContain("is_archived=false");
  });

  it("sends is_archived=true param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ is_archived: true });
    expect(capturedUrl).toContain("is_archived=true");
  });
});

describe("listGeneralMeetings with params", () => {
  // --- Happy path ---

  it("sends limit and offset params", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ limit: 20, offset: 20 });
    expect(capturedUrl).toContain("limit=20");
    expect(capturedUrl).toContain("offset=20");
  });

  it("sends name param", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ name: "AGM" });
    expect(capturedUrl).toContain("name=AGM");
  });

  it("sends building_id param", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ building_id: "b-789" });
    expect(capturedUrl).toContain("building_id=b-789");
  });

  it("sends no query string when no params given", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings();
    expect(capturedUrl).not.toContain("?");
  });

  it("sends status param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ status: "open" });
    expect(capturedUrl).toContain("status=open");
  });

  it("sends all params together", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ limit: 20, offset: 40, building_id: "b-1", status: "closed" });
    expect(capturedUrl).toContain("limit=20");
    expect(capturedUrl).toContain("offset=40");
    expect(capturedUrl).toContain("building_id=b-1");
    expect(capturedUrl).toContain("status=closed");
  });
});

describe("deleteGeneralMeeting", () => {
  // --- Happy path ---

  it("resolves without error on 204", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/general-meetings/:meetingId`, () =>
        new HttpResponse(null, { status: 204 })
      )
    );
    await expect(deleteGeneralMeeting("agm-123")).resolves.toBeUndefined();
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/general-meetings/:meetingId`, () =>
        HttpResponse.json({ detail: "Cannot delete" }, { status: 409 })
      )
    );
    await expect(deleteGeneralMeeting("agm-conflict")).rejects.toThrow("409");
  });
});

describe("deleteBuilding", () => {
  // --- Happy path ---

  it("resolves without error on 204", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/buildings/:buildingId`, () =>
        new HttpResponse(null, { status: 204 })
      )
    );
    await expect(deleteBuilding("b-123")).resolves.toBeUndefined();
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/buildings/:buildingId`, () =>
        HttpResponse.json({ detail: "Cannot delete" }, { status: 409 })
      )
    );
    await expect(deleteBuilding("b-conflict")).rejects.toThrow("409");
  });
});

describe("deleteMotion", () => {
  // --- Happy path ---

  it("resolves without error on 204", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/motions/:motionId`, () =>
        new HttpResponse(null, { status: 204 })
      )
    );
    await expect(deleteMotion("m-123")).resolves.toBeUndefined();
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/motions/:motionId`, () =>
        HttpResponse.json({ detail: "Cannot delete" }, { status: 409 })
      )
    );
    await expect(deleteMotion("m-conflict")).rejects.toThrow("409");
  });
});

describe("importBuildings", () => {
  // --- Happy path ---

  it("posts FormData and returns parsed result", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/import`, () =>
        HttpResponse.json({ created: 3, updated: 1 })
      )
    );
    const file = new File(["data"], "buildings.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const result = await importBuildings(file);
    expect(result).toEqual({ created: 3, updated: 1 });
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/import`, () =>
        HttpResponse.json({ detail: "Invalid file" }, { status: 422 })
      )
    );
    const file = new File(["bad"], "bad.txt");
    await expect(importBuildings(file)).rejects.toThrow("422");
  });
});

describe("importLotOwners", () => {
  // --- Happy path ---

  it("posts FormData and returns parsed result", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import`, () =>
        HttpResponse.json({ imported: 10, emails: 8 })
      )
    );
    const file = new File(["data"], "owners.xlsx");
    const result = await importLotOwners("b-1", file);
    expect(result).toEqual({ imported: 10, emails: 8 });
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import`, () =>
        HttpResponse.json({ detail: "Missing columns" }, { status: 422 })
      )
    );
    const file = new File(["bad"], "bad.xlsx");
    await expect(importLotOwners("b-1", file)).rejects.toThrow("422");
  });
});

describe("importProxyNominations", () => {
  // --- Happy path ---

  it("posts FormData and returns parsed result", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import-proxies`, () =>
        HttpResponse.json({ upserted: 5, removed: 1, skipped: 0 })
      )
    );
    const file = new File(["data"], "proxies.xlsx");
    const result = await importProxyNominations("b-1", file);
    expect(result).toEqual({ upserted: 5, removed: 1, skipped: 0 });
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import-proxies`, () =>
        HttpResponse.json({ detail: "Bad file" }, { status: 422 })
      )
    );
    const file = new File(["bad"], "bad.csv");
    await expect(importProxyNominations("b-1", file)).rejects.toThrow("422");
  });
});

describe("importFinancialPositions", () => {
  // --- Happy path ---

  it("posts FormData and returns parsed result", async () => {
    server.use(
      http.post(
        `${BASE}/api/admin/buildings/:buildingId/lot-owners/import-financial-positions`,
        () => HttpResponse.json({ updated: 20, skipped: 2 })
      )
    );
    const file = new File(["data"], "positions.csv");
    const result = await importFinancialPositions("b-1", file);
    expect(result).toEqual({ updated: 20, skipped: 2 });
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.post(
        `${BASE}/api/admin/buildings/:buildingId/lot-owners/import-financial-positions`,
        () => HttpResponse.json({ detail: "Bad CSV" }, { status: 422 })
      )
    );
    const file = new File(["bad"], "bad.csv");
    await expect(importFinancialPositions("b-1", file)).rejects.toThrow("422");
  });
});
