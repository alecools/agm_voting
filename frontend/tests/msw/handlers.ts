import { http, HttpResponse } from "msw";
import type { Building, LotOwner } from "../../src/types";
import type {
  BuildingImportResult,
  LotOwnerImportResult,
  ProxyImportResult,
  FinancialPositionImportResult,
  GeneralMeetingListItem,
  GeneralMeetingDetail,
  GeneralMeetingOut,
  GeneralMeetingCloseOut,
  GeneralMeetingStartOut,
  ResendReportOut,
} from "../../src/api/admin";
import type { GeneralMeetingSummaryData } from "../../src/api/public";

const BASE = "http://localhost:8000";

export const ADMIN_BUILDINGS: Building[] = [
  {
    id: "b1",
    name: "Alpha Tower",
    manager_email: "alpha@example.com",
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "b2",
    name: "Beta Court",
    manager_email: "beta@example.com",
    is_archived: false,
    created_at: "2024-02-01T00:00:00Z",
  },
];

export const ADMIN_LOT_OWNERS: LotOwner[] = [
  {
    id: "lo1",
    building_id: "b1",
    lot_number: "1A",
    emails: ["owner1@example.com"],
    unit_entitlement: 100,
    financial_position: "normal",
    proxy_email: null,
  },
  {
    id: "lo2",
    building_id: "b1",
    lot_number: "2B",
    emails: ["owner2@example.com"],
    unit_entitlement: 200,
    financial_position: "normal",
    proxy_email: "proxy@example.com",
  },
];

export const ADMIN_MEETING_LIST: GeneralMeetingListItem[] = [
  {
    id: "agm1",
    building_id: "b1",
    building_name: "Alpha Tower",
    title: "2024 AGM",
    status: "open",
    meeting_at: "2024-06-01T10:00:00Z",
    voting_closes_at: "2024-06-01T12:00:00Z",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "agm2",
    building_id: "b2",
    building_name: "Beta Court",
    title: "2023 AGM",
    status: "closed",
    meeting_at: "2023-06-01T10:00:00Z",
    voting_closes_at: "2023-06-01T12:00:00Z",
    created_at: "2023-01-01T00:00:00Z",
  },
  {
    id: "agm3",
    building_id: "b1",
    building_name: "Alpha Tower",
    title: "2026 AGM",
    status: "pending",
    meeting_at: "2026-12-01T10:00:00Z",
    voting_closes_at: "2026-12-31T12:00:00Z",
    created_at: "2025-01-01T00:00:00Z",
  },
];

// Keep backward-compatible alias
export const ADMIN_AGM_LIST = ADMIN_MEETING_LIST;

export const ADMIN_MEETING_DETAIL: GeneralMeetingDetail = {
  id: "agm1",
  building_name: "Alpha Tower",
  title: "2024 AGM",
  status: "open",
  meeting_at: "2024-06-01T10:00:00Z",
  voting_closes_at: "2024-06-01T12:00:00Z",
  closed_at: null,
  total_eligible_voters: 5,
  total_submitted: 3,
  total_entitlement: 450,
  motions: [
    {
      id: "m1",
      title: "Motion 1",
      description: "Description 1",
      order_index: 0,
      motion_type: "general" as const,
      tally: {
        yes: { voter_count: 2, entitlement_sum: 200 },
        no: { voter_count: 1, entitlement_sum: 100 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 2, entitlement_sum: 150 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
      },
      voter_lists: {
        yes: [
          { voter_email: "voter1@example.com", entitlement: 100 },
          { voter_email: "voter2@example.com", entitlement: 100 },
        ],
        no: [{ voter_email: "voter3@example.com", entitlement: 100 }],
        abstained: [],
        absent: [
          { voter_email: "voter4@example.com", entitlement: 100 },
          { voter_email: "voter5@example.com", entitlement: 50 },
        ],
        not_eligible: [],
      },
    },
  ],
};

// Keep backward-compatible alias
export const ADMIN_AGM_DETAIL = ADMIN_MEETING_DETAIL;

export const ADMIN_MEETING_DETAIL_CLOSED: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm2",
  title: "2023 AGM",
  status: "closed",
  closed_at: "2023-06-01T13:00:00Z",
};

export const ADMIN_MEETING_DETAIL_PENDING: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm-pending",
  title: "2026 AGM",
  status: "pending",
  closed_at: null,
  meeting_at: "2026-12-01T10:00:00Z",
  voting_closes_at: "2026-12-31T12:00:00Z",
};

// Keep backward-compatible alias
export const ADMIN_AGM_DETAIL_CLOSED = ADMIN_MEETING_DETAIL_CLOSED;

export const ADMIN_CREATED_MEETING: GeneralMeetingOut = {
  id: "agm-new",
  building_id: "b1",
  title: "New AGM",
  status: "open",
  meeting_at: "2025-06-01T10:00:00Z",
  voting_closes_at: "2025-06-01T12:00:00Z",
  motions: [
    {
      id: "m-new",
      title: "First Motion",
      description: null,
      order_index: 0,
      motion_type: "general" as const,
    },
  ],
};

// Keep backward-compatible alias
export const ADMIN_CREATED_AGM = ADMIN_CREATED_MEETING;

export const adminHandlers = [
  http.get(`${BASE}/api/admin/auth/me`, () => {
    return HttpResponse.json({ authenticated: true });
  }),

  http.post(`${BASE}/api/admin/auth/login`, async ({ request }) => {
    const body = await request.json() as { username?: string; password?: string };
    if (body?.username === "admin" && body?.password === "admin") {
      return HttpResponse.json({ ok: true });
    }
    return HttpResponse.json({ detail: "Invalid credentials" }, { status: 401 });
  }),

  http.post(`${BASE}/api/admin/auth/logout`, () => {
    return HttpResponse.json({ ok: true });
  }),

  http.get(`${BASE}/api/admin/buildings`, () => {
    return HttpResponse.json(ADMIN_BUILDINGS);
  }),

  http.post(`${BASE}/api/admin/buildings`, async ({ request }) => {
    const body = await request.json() as { name?: string; manager_email?: string };
    const newBuilding: Building = {
      id: "b-new",
      name: body?.name ?? "New Building",
      manager_email: body?.manager_email ?? "mgr@example.com",
      is_archived: false,
      created_at: "2024-03-01T00:00:00Z",
    };
    return HttpResponse.json(newBuilding, { status: 201 });
  }),

  http.post(`${BASE}/api/admin/buildings/:buildingId/archive`, ({ params }) => {
    const building = ADMIN_BUILDINGS.find((b) => b.id === params.buildingId);
    if (!building) {
      return HttpResponse.json({ detail: "Building not found" }, { status: 404 });
    }
    return HttpResponse.json({ id: building.id, name: building.name, is_archived: true });
  }),

  http.patch(`${BASE}/api/admin/buildings/:buildingId`, async ({ request, params }) => {
    const building = ADMIN_BUILDINGS.find((b) => b.id === params.buildingId);
    if (!building) {
      return HttpResponse.json({ detail: "Building not found" }, { status: 404 });
    }
    const body = await request.json() as { name?: string; manager_email?: string };
    const updated: Building = {
      ...building,
      name: body?.name ?? building.name,
      manager_email: body?.manager_email ?? building.manager_email,
    };
    return HttpResponse.json(updated);
  }),

  http.post(`${BASE}/api/admin/buildings/import`, () => {
    return HttpResponse.json<BuildingImportResult>({ created: 2, updated: 1 });
  }),

  http.get(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, () => {
    return HttpResponse.json(ADMIN_LOT_OWNERS);
  }),

  http.get(`${BASE}/api/admin/lot-owners/:lotOwnerId`, ({ params }) => {
    const owner = ADMIN_LOT_OWNERS.find((lo) => lo.id === params.lotOwnerId);
    if (!owner) {
      return HttpResponse.json({ detail: "Lot owner not found" }, { status: 404 });
    }
    return HttpResponse.json(owner);
  }),

  http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners`, async ({ request }) => {
    const body = await request.json() as { lot_number?: string };
    if (body?.lot_number === "DUPLICATE") {
      return HttpResponse.json(
        { detail: "lot_number 'DUPLICATE' already exists in this building" },
        { status: 409 }
      );
    }
    const newOwner: LotOwner = {
      id: "lo-new",
      building_id: "b1",
      lot_number: body?.lot_number ?? "NEW",
      emails: ["new@example.com"],
      unit_entitlement: 50,
      financial_position: "normal",
      proxy_email: null,
    };
    return HttpResponse.json(newOwner, { status: 201 });
  }),

  http.post(`${BASE}/api/admin/lot-owners/:lotOwnerId/emails`, async ({ request, params }) => {
    const body = await request.json() as { email?: string };
    const updated: LotOwner = {
      ...ADMIN_LOT_OWNERS[0],
      id: params.lotOwnerId as string,
      emails: [...ADMIN_LOT_OWNERS[0].emails, body?.email ?? "new@example.com"],
    };
    return HttpResponse.json(updated);
  }),

  http.delete(`${BASE}/api/admin/lot-owners/:lotOwnerId/emails/:email`, ({ params }) => {
    const emailToRemove = decodeURIComponent(params.email as string);
    const updated: LotOwner = {
      ...ADMIN_LOT_OWNERS[0],
      id: params.lotOwnerId as string,
      emails: ADMIN_LOT_OWNERS[0].emails.filter((e) => e !== emailToRemove),
    };
    return HttpResponse.json(updated);
  }),

  http.patch(`${BASE}/api/admin/lot-owners/:lotOwnerId`, async ({ request }) => {
    const body = await request.json() as { unit_entitlement?: number; financial_position?: string };
    if (body?.unit_entitlement !== undefined && body.unit_entitlement < 0) {
      return HttpResponse.json(
        { detail: "unit_entitlement must be >= 0" },
        { status: 422 }
      );
    }
    const updated: LotOwner = {
      ...ADMIN_LOT_OWNERS[0],
      unit_entitlement: body?.unit_entitlement ?? ADMIN_LOT_OWNERS[0].unit_entitlement,
      financial_position: (body?.financial_position as "normal" | "in_arrear") ?? ADMIN_LOT_OWNERS[0].financial_position,
    };
    return HttpResponse.json(updated);
  }),

  http.put(`${BASE}/api/admin/lot-owners/:lotOwnerId/proxy`, async ({ request, params }) => {
    const body = await request.json() as { proxy_email?: string };
    const updated: LotOwner = {
      ...ADMIN_LOT_OWNERS[0],
      id: params.lotOwnerId as string,
      proxy_email: body?.proxy_email ?? null,
    };
    return HttpResponse.json(updated);
  }),

  http.delete(`${BASE}/api/admin/lot-owners/:lotOwnerId/proxy`, ({ params }) => {
    const owner = ADMIN_LOT_OWNERS.find((lo) => lo.id === params.lotOwnerId);
    if (!owner?.proxy_email) {
      return HttpResponse.json({ detail: "No proxy nomination found for this lot owner" }, { status: 404 });
    }
    const updated: LotOwner = {
      ...owner,
      proxy_email: null,
    };
    return HttpResponse.json(updated);
  }),

  http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import`, () => {
    return HttpResponse.json<LotOwnerImportResult>({ imported: 5, emails: 5 });
  }),

  http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import-proxies`, () => {
    return HttpResponse.json<ProxyImportResult>({ upserted: 3, removed: 1, skipped: 0 });
  }),

  http.post(`${BASE}/api/admin/buildings/:buildingId/lot-owners/import-financial-positions`, () => {
    return HttpResponse.json<FinancialPositionImportResult>({ updated: 4, skipped: 0 });
  }),

  http.get(`${BASE}/api/admin/general-meetings`, () => {
    return HttpResponse.json(ADMIN_MEETING_LIST);
  }),

  http.post(`${BASE}/api/admin/general-meetings`, async ({ request }) => {
    const body = await request.json() as { building_id?: string };
    if (body?.building_id === "conflict-building") {
      return HttpResponse.json(
        { detail: "An open General Meeting already exists for this building" },
        { status: 409 }
      );
    }
    return HttpResponse.json(ADMIN_CREATED_MEETING, { status: 201 });
  }),

  http.get(`${BASE}/api/admin/general-meetings/:meetingId`, ({ params }) => {
    if (params.meetingId === "agm2") {
      return HttpResponse.json(ADMIN_MEETING_DETAIL_CLOSED);
    }
    if (params.meetingId === "agm-notfound") {
      return HttpResponse.json({ detail: "General Meeting not found" }, { status: 404 });
    }
    if (params.meetingId === "agm-failed-email") {
      return HttpResponse.json({
        ...ADMIN_MEETING_DETAIL_CLOSED,
        id: "agm-failed-email",
        email_delivery: { status: "failed", last_error: "SMTP error" },
      });
    }
    if (params.meetingId === "agm-pending") {
      return HttpResponse.json(ADMIN_MEETING_DETAIL_PENDING);
    }
    return HttpResponse.json(ADMIN_MEETING_DETAIL);
  }),

  http.post(`${BASE}/api/admin/general-meetings/:meetingId/start`, ({ params }) => {
    if (params.meetingId === "agm-not-pending") {
      return HttpResponse.json({ detail: "General Meeting is not in pending status" }, { status: 409 });
    }
    const result: GeneralMeetingStartOut = {
      id: params.meetingId as string,
      status: "open",
      meeting_at: new Date().toISOString(),
    };
    return HttpResponse.json(result);
  }),

  http.post(`${BASE}/api/admin/general-meetings/:meetingId/close`, ({ params }) => {
    if (params.meetingId === "agm-already-closed") {
      return HttpResponse.json({ detail: "General Meeting is already closed" }, { status: 409 });
    }
    const result: GeneralMeetingCloseOut = {
      id: params.meetingId as string,
      status: "closed",
      closed_at: "2024-06-01T13:00:00Z",
    };
    return HttpResponse.json(result);
  }),

  http.post(`${BASE}/api/admin/general-meetings/:meetingId/resend-report`, ({ params }) => {
    if (params.meetingId === "agm-resend-fail") {
      return HttpResponse.json({ detail: "Cannot resend" }, { status: 409 });
    }
    const result: ResendReportOut = { queued: true };
    return HttpResponse.json(result);
  }),
];

export const SUMMARY_AGM_ID = "agm-summary-test-999";

export const agmSummaryFixture: GeneralMeetingSummaryData = {
  general_meeting_id: SUMMARY_AGM_ID,
  building_id: "bld-summary-999",
  title: "2024 AGM",
  status: "open",
  meeting_at: "2024-06-01T10:00:00Z",
  voting_closes_at: "2024-06-01T18:00:00Z",
  building_name: "Sunset Towers",
  motions: [
    { order_index: 0, title: "Motion 1", description: "Approve the budget" },
    { order_index: 1, title: "Motion 2", description: null },
  ],
};

export const AGM_ID = "agm-111";
export const BUILDING_ID = "bld-222";

// Summary fixture for AGM_ID — used by AuthPage tests (building_id must match BUILDING_ID)
export const agmAuthSummaryFixture: GeneralMeetingSummaryData = {
  general_meeting_id: AGM_ID,
  building_id: BUILDING_ID,
  title: "2024 AGM",
  status: "open",
  meeting_at: "2024-06-01T10:00:00Z",
  voting_closes_at: "2024-06-01T12:00:00Z",
  building_name: "Sunset Towers",
  motions: [],
};
export const MOTION_ID_1 = "mot-001";
export const MOTION_ID_2 = "mot-002";

export const buildingFixture = { id: BUILDING_ID, name: "Sunset Towers" };

export const agmOpenFixture = {
  id: AGM_ID,
  title: "2024 AGM",
  status: "open" as const,
  meeting_at: "2024-06-01T10:00:00Z",
  voting_closes_at: "2024-06-01T12:00:00Z",
};

export const agmClosedFixture = {
  id: "agm-closed-999",
  title: "2023 AGM",
  status: "closed" as const,
  meeting_at: "2023-06-01T10:00:00Z",
  voting_closes_at: "2023-06-01T12:00:00Z",
};

export const motionFixtures = [
  {
    id: MOTION_ID_1,
    title: "Motion 1",
    description: "Approve the budget",
    order_index: 0,
  },
  {
    id: MOTION_ID_2,
    title: "Motion 2",
    description: null,
    order_index: 1,
  },
];

export const myBallotFixture = {
  voter_email: "owner@example.com",
  meeting_title: "2024 AGM",
  building_name: "Sunset Towers",
  submitted_lots: [
    {
      lot_owner_id: "lo-e2e",
      lot_number: "E2E-1",
      financial_position: "normal",
      votes: [
        {
          motion_id: MOTION_ID_1,
          motion_title: "Motion 1",
          order_index: 0,
          choice: "yes" as const,
          eligible: true,
        },
        {
          motion_id: MOTION_ID_2,
          motion_title: "Motion 2",
          order_index: 1,
          choice: "no" as const,
          eligible: true,
        },
      ],
    },
  ],
  remaining_lot_owner_ids: [],
};

export const handlers = [
  ...adminHandlers,
  http.get(`${BASE}/api/server-time`, () =>
    HttpResponse.json({ utc: "2024-06-01T10:00:00Z" })
  ),

  http.get(`${BASE}/api/buildings`, () =>
    HttpResponse.json([buildingFixture])
  ),

  http.get(`${BASE}/api/buildings/:buildingId/general-meetings`, () =>
    HttpResponse.json([agmOpenFixture, agmClosedFixture])
  ),

  http.post(`${BASE}/api/auth/verify`, () =>
    HttpResponse.json({
      lots: [{ lot_owner_id: "lo-e2e", lot_number: "E2E-1", financial_position: "normal", already_submitted: false, is_proxy: false }],
      voter_email: "owner@example.com",
      agm_status: "open",
      building_name: "Sunset Towers",
      meeting_title: "2024 AGM",
    })
  ),

  http.get(`${BASE}/api/general-meeting/:meetingId/motions`, () =>
    HttpResponse.json(motionFixtures)
  ),

  http.get(`${BASE}/api/general-meeting/:meetingId/drafts`, () =>
    HttpResponse.json({ drafts: [] })
  ),

  http.put(`${BASE}/api/general-meeting/:meetingId/draft`, () =>
    HttpResponse.json({ saved: true })
  ),

  http.post(`${BASE}/api/general-meeting/:meetingId/submit`, () =>
    HttpResponse.json({
      submitted: true,
      lots: [
        {
          lot_owner_id: "lo-e2e",
          lot_number: "E2E-1",
          votes: [
            { motion_id: MOTION_ID_1, motion_title: "Motion 1", choice: "yes" },
            { motion_id: MOTION_ID_2, motion_title: "Motion 2", choice: "abstained" },
          ],
        },
      ],
    })
  ),

  http.get(`${BASE}/api/general-meeting/:meetingId/my-ballot`, () =>
    HttpResponse.json(myBallotFixture)
  ),

  http.get(`${BASE}/api/general-meeting/:meetingId/summary`, ({ params }) => {
    if (params.meetingId === "agm-summary-notfound") {
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    }
    if (params.meetingId === AGM_ID) {
      return HttpResponse.json(agmAuthSummaryFixture);
    }
    return HttpResponse.json(agmSummaryFixture);
  }),
];
