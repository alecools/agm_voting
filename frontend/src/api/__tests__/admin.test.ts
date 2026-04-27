import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import {
  getBuildingsCount,
  getGeneralMeetingsCount,
  listBuildings,
  listGeneralMeetings,
  listLotOwners,
  countLotOwners,
  deleteGeneralMeeting,
  deleteBuilding,
  deleteMotion,
  importBuildings,
  importLotOwners,
  importProxyNominations,
  importFinancialPositions,
  closeMotion,
} from "../admin";

const BASE = "http://localhost";

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

  it("sends sort_by param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ sort_by: "name" });
    expect(capturedUrl).toContain("sort_by=name");
  });

  it("sends sort_dir param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ sort_by: "name", sort_dir: "asc" });
    expect(capturedUrl).toContain("sort_by=name");
    expect(capturedUrl).toContain("sort_dir=asc");
  });

  it("does not send sort params when they are undefined", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listBuildings({ limit: 20 });
    expect(capturedUrl).not.toContain("sort_by");
    expect(capturedUrl).not.toContain("sort_dir");
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

  it("sends sort_by param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ sort_by: "title" });
    expect(capturedUrl).toContain("sort_by=title");
  });

  it("sends sort_dir param when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ sort_by: "title", sort_dir: "asc" });
    expect(capturedUrl).toContain("sort_by=title");
    expect(capturedUrl).toContain("sort_dir=asc");
  });

  it("does not send sort params when they are undefined", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listGeneralMeetings({ limit: 20 });
    expect(capturedUrl).not.toContain("sort_by");
    expect(capturedUrl).not.toContain("sort_dir");
  });
});

describe("listLotOwners", () => {
  // --- Happy path ---

  it("fetches lot owners without pagination params", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([{ id: "lo1" }]);
      })
    );
    const result = await listLotOwners("b1");
    expect(result).toEqual([{ id: "lo1" }]);
    expect(capturedUrl).not.toContain("?");
  });

  it("sends limit and offset when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listLotOwners("b1", { limit: 20, offset: 40 });
    expect(capturedUrl).toContain("limit=20");
    expect(capturedUrl).toContain("offset=40");
  });

  it("sends only limit when offset is undefined", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listLotOwners("b1", { limit: 20 });
    expect(capturedUrl).toContain("limit=20");
    expect(capturedUrl).not.toContain("offset");
  });

  it("sends only offset when limit is undefined", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listLotOwners("b1", { offset: 20 });
    expect(capturedUrl).toContain("offset=20");
    expect(capturedUrl).not.toContain("limit");
  });

  it("sends no query string when params object is empty", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    await listLotOwners("b1", {});
    expect(capturedUrl).not.toContain("?");
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 })
      )
    );
    await expect(listLotOwners("b-missing")).rejects.toThrow("404");
  });
});

describe("countLotOwners", () => {
  // --- Happy path ---

  it("returns count as a number", async () => {
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners/count`, () =>
        HttpResponse.json({ count: 42 })
      )
    );
    const result = await countLotOwners("b1");
    expect(result).toBe(42);
  });

  it("returns 0 for empty building", async () => {
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners/count`, () =>
        HttpResponse.json({ count: 0 })
      )
    );
    const result = await countLotOwners("b-empty");
    expect(result).toBe(0);
  });

  // --- State / precondition errors ---

  it("throws on non-ok response", async () => {
    server.use(
      http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners/count`, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 })
      )
    );
    await expect(countLotOwners("b-missing")).rejects.toThrow("404");
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

describe("closeMotion", () => {
  it("calls POST /api/admin/motions/{id}/close and returns MotionDetail", async () => {
    const motionDetail = {
      id: "m-close-test",
      title: "Test Motion",
      description: null,
      display_order: 1,
      motion_number: null,
      motion_type: "general",
      is_multi_choice: false,
      is_visible: true,
      option_limit: null,
      options: [],
      voting_closed_at: "2024-06-01T11:00:00Z",
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    };
    server.use(
      http.post(`${BASE}/api/admin/motions/m-close-test/close`, () =>
        HttpResponse.json(motionDetail)
      )
    );
    const result = await closeMotion("m-close-test");
    expect(result.id).toBe("m-close-test");
    expect(result.voting_closed_at).toBe("2024-06-01T11:00:00Z");
  });

  it("throws on 409 when motion is already closed", async () => {
    server.use(
      http.post(`${BASE}/api/admin/motions/m-already-closed/close`, () =>
        HttpResponse.json({ detail: "Motion voting is already closed" }, { status: 409 })
      )
    );
    await expect(closeMotion("m-already-closed")).rejects.toThrow("409");
  });

  it("throws on 404 when motion is not found", async () => {
    server.use(
      http.post(`${BASE}/api/admin/motions/m-notfound/close`, () =>
        HttpResponse.json({ detail: "Motion not found" }, { status: 404 })
      )
    );
    await expect(closeMotion("m-notfound")).rejects.toThrow("404");
  });
});
