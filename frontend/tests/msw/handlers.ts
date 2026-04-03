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
  MotionOut,
  MotionReorderOut,
  ResendReportOut,
} from "../../src/api/admin";
import type { GeneralMeetingSummaryData } from "../../src/api/public";
import type { TenantConfig, SmtpConfig, SmtpStatus } from "../../src/api/config";

const BASE = "http://localhost:8000";

export let configFixture: TenantConfig = {
  app_name: "General Meeting",
  logo_url: "",
  favicon_url: null,
  primary_colour: "#005f73",
  support_email: "",
};

export let smtpConfigFixture: SmtpConfig = {
  smtp_host: "",
  smtp_port: 587,
  smtp_username: "",
  smtp_from_email: "",
  password_is_set: false,
};

export function resetSmtpConfigFixture() {
  smtpConfigFixture = {
    smtp_host: "",
    smtp_port: 587,
    smtp_username: "",
    smtp_from_email: "",
    password_is_set: false,
  };
}

export let smtpStatusFixture: SmtpStatus = { configured: false };

export function resetSmtpStatusFixture() {
  smtpStatusFixture = { configured: false };
}

export function resetConfigFixture() {
  configFixture = {
    app_name: "General Meeting",
    logo_url: "",
    favicon_url: null,
    primary_colour: "#005f73",
    support_email: "",
  };
  resetSmtpConfigFixture();
  resetSmtpStatusFixture();
}

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
  {
    id: "b3",
    name: "Gamma House",
    manager_email: "gamma@example.com",
    is_archived: true,
    created_at: "2022-01-01T00:00:00Z",
  },
];

export const ADMIN_LOT_OWNERS: LotOwner[] = [
  {
    id: "lo1",
    building_id: "b1",
    lot_number: "1A",
    given_name: "Alice",
    surname: "Smith",
    emails: ["owner1@example.com"],
    unit_entitlement: 100,
    financial_position: "normal",
    proxy_email: null,
  },
  {
    id: "lo2",
    building_id: "b1",
    lot_number: "2B",
    given_name: null,
    surname: null,
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
  building_id: "b1",
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
      display_order: 1,
      motion_number: null,
      motion_type: "general" as const,
      is_visible: true,
      option_limit: null,
      options: [],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 2, entitlement_sum: 200 },
        no: { voter_count: 1, entitlement_sum: 100 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 2, entitlement_sum: 150 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
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
        options: {},
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
  email_delivery: null,
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

export const ADMIN_MEETING_DETAIL_HIDDEN_MOTION: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm-hidden-motion",
  motions: [
    {
      id: "m-hidden",
      title: "Hidden Motion",
      description: "Hidden desc",
      display_order: 1,
      motion_number: "M-42",
      motion_type: "general" as const,
      is_visible: false,
      option_limit: null,
      options: [],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    },
  ],
};

// Keep backward-compatible alias
export const ADMIN_AGM_DETAIL_CLOSED = ADMIN_MEETING_DETAIL_CLOSED;

export const ADMIN_MEETING_DETAIL_MIXED_VISIBILITY: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm-mixed",
  motions: [
    {
      id: "m-visible-1",
      title: "Visible Motion 1",
      description: null,
      display_order: 1,
      motion_number: null,
      motion_type: "general" as const,
      is_visible: true,
      option_limit: null,
      options: [],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    },
    {
      id: "m-hidden-1",
      title: "Hidden Motion 1",
      description: null,
      display_order: 2,
      motion_number: null,
      motion_type: "general" as const,
      is_visible: false,
      option_limit: null,
      options: [],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    },
    {
      id: "m-hidden-2",
      title: "Hidden Motion 2",
      description: null,
      display_order: 3,
      motion_number: null,
      motion_type: "special" as const,
      is_visible: false,
      option_limit: null,
      options: [],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    },
  ],
};

export const ADMIN_MEETING_DETAIL_ALL_HIDDEN: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm-all-hidden",
  motions: [
    {
      id: "m-only-hidden",
      title: "Only Hidden Motion",
      description: null,
      display_order: 1,
      motion_number: null,
      motion_type: "general" as const,
      is_visible: false,
      option_limit: null,
      options: [],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: { yes: [], no: [], abstained: [], absent: [], not_eligible: [], options: {} },
    },
  ],
};

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
      display_order: 1,
      motion_number: null,
      motion_type: "general" as const,
      is_visible: true,
      option_limit: null,
      options: [],
    },
  ],
};

// Keep backward-compatible alias
export const ADMIN_CREATED_AGM = ADMIN_CREATED_MEETING;

// Multi-choice meeting detail fixture with computed outcomes (Slice 4)
export const ADMIN_MEETING_DETAIL_MC_OUTCOME: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm-mc-outcome",
  status: "closed",
  closed_at: "2024-06-01T13:00:00Z",
  motions: [
    {
      id: "mc-outcome-m1",
      title: "Board Election",
      description: null,
      display_order: 1,
      motion_number: "1",
      motion_type: "general" as const,
      is_multi_choice: true,
      is_visible: true,
      option_limit: 2,
      options: [
        { id: "mc-opt-a", text: "Alice", display_order: 1 },
        { id: "mc-opt-b", text: "Bob", display_order: 2 },
        { id: "mc-opt-c", text: "Carol", display_order: 3 },
      ],
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [
          { option_id: "mc-opt-a", option_text: "Alice", display_order: 1, voter_count: 3, entitlement_sum: 300, outcome: "pass" },
          { option_id: "mc-opt-b", option_text: "Bob", display_order: 2, voter_count: 2, entitlement_sum: 200, outcome: "pass" },
          { option_id: "mc-opt-c", option_text: "Carol", display_order: 3, voter_count: 1, entitlement_sum: 100, outcome: "fail" },
        ],
      },
      voter_lists: {
        yes: [],
        no: [],
        abstained: [],
        absent: [],
        not_eligible: [],
        options: {},
      },
    },
  ],
};

/** US-AVE2-01: meeting with a multi-choice motion for admin vote entry tests */
export const ADMIN_MEETING_DETAIL_MC_VOTE_ENTRY: GeneralMeetingDetail = {
  ...ADMIN_MEETING_DETAIL,
  id: "agm-mc-entry",
  status: "open",
  closed_at: null,
  motions: [
    {
      id: "mc-entry-m1",
      title: "Board Election Entry",
      description: null,
      display_order: 1,
      motion_number: "1",
      motion_type: "general" as const,
      is_multi_choice: true,
      is_visible: true,
      option_limit: 2,
      options: [
        { id: "mc-entry-opt-a", text: "Alice", display_order: 1 },
        { id: "mc-entry-opt-b", text: "Bob", display_order: 2 },
        { id: "mc-entry-opt-c", text: "Carol", display_order: 3 },
      ],
      voting_closed_at: null,
      tally: {
        yes: { voter_count: 0, entitlement_sum: 0 },
        no: { voter_count: 0, entitlement_sum: 0 },
        abstained: { voter_count: 0, entitlement_sum: 0 },
        absent: { voter_count: 0, entitlement_sum: 0 },
        not_eligible: { voter_count: 0, entitlement_sum: 0 },
        options: [],
      },
      voter_lists: {
        yes: [],
        no: [],
        abstained: [],
        absent: [],
        not_eligible: [],
        options: {},
      },
    },
  ],
};

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

  http.get(`${BASE}/api/admin/buildings/count`, ({ request }) => {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    const isArchivedParam = url.searchParams.get("is_archived");
    let filtered = ADMIN_BUILDINGS;
    if (name) filtered = filtered.filter((b) => b.name.toLowerCase().includes(name.toLowerCase()));
    if (isArchivedParam !== null) {
      const isArchived = isArchivedParam === "true";
      filtered = filtered.filter((b) => b.is_archived === isArchived);
    }
    return HttpResponse.json({ count: filtered.length });
  }),

  http.get(`${BASE}/api/admin/buildings`, ({ request }) => {
    const url = new URL(request.url);
    const isArchivedParam = url.searchParams.get("is_archived");
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");
    let filtered = ADMIN_BUILDINGS;
    if (isArchivedParam !== null) {
      const isArchived = isArchivedParam === "true";
      filtered = filtered.filter((b) => b.is_archived === isArchived);
    }
    const offset = offsetParam !== null ? parseInt(offsetParam, 10) : 0;
    const limit = limitParam !== null ? parseInt(limitParam, 10) : filtered.length;
    return HttpResponse.json(filtered.slice(offset, offset + limit));
  }),

  http.get(`${BASE}/api/admin/buildings/:buildingId`, ({ params }) => {
    const building = ADMIN_BUILDINGS.find((b) => b.id === params.buildingId);
    if (!building) {
      return HttpResponse.json({ detail: "Building not found" }, { status: 404 });
    }
    return HttpResponse.json(building);
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
      given_name: null,
      surname: null,
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

  http.get(`${BASE}/api/admin/general-meetings/count`, ({ request }) => {
    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    const buildingId = url.searchParams.get("building_id");
    const status = url.searchParams.get("status");
    let filtered = ADMIN_MEETING_LIST;
    if (name) filtered = filtered.filter((m) => m.title.toLowerCase().includes(name.toLowerCase()));
    if (buildingId) filtered = filtered.filter((m) => m.building_id === buildingId);
    if (status) filtered = filtered.filter((m) => m.status === status);
    return HttpResponse.json({ count: filtered.length });
  }),

  http.get(`${BASE}/api/admin/general-meetings`, ({ request }) => {
    const url = new URL(request.url);
    const buildingId = url.searchParams.get("building_id");
    const status = url.searchParams.get("status");
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");
    let filtered = ADMIN_MEETING_LIST;
    if (buildingId) filtered = filtered.filter((m) => m.building_id === buildingId);
    if (status) filtered = filtered.filter((m) => m.status === status);
    const offset = offsetParam !== null ? parseInt(offsetParam, 10) : 0;
    const limit = limitParam !== null ? parseInt(limitParam, 10) : filtered.length;
    return HttpResponse.json(filtered.slice(offset, offset + limit));
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
    if (params.meetingId === "agm-delivered-email") {
      return HttpResponse.json({
        ...ADMIN_MEETING_DETAIL_CLOSED,
        id: "agm-delivered-email",
        email_delivery: { status: "delivered", last_error: null },
      });
    }
    if (params.meetingId === "agm-pending") {
      return HttpResponse.json(ADMIN_MEETING_DETAIL_PENDING);
    }
    if (params.meetingId === "agm-hidden-motion") {
      return HttpResponse.json(ADMIN_MEETING_DETAIL_HIDDEN_MOTION);
    }
    if (params.meetingId === "agm-mixed") {
      return HttpResponse.json(ADMIN_MEETING_DETAIL_MIXED_VISIBILITY);
    }
    if (params.meetingId === "agm-all-hidden") {
      return HttpResponse.json(ADMIN_MEETING_DETAIL_ALL_HIDDEN);
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

  http.delete(`${BASE}/api/admin/buildings/:buildingId`, ({ params }) => {
    const building = ADMIN_BUILDINGS.find((b) => b.id === params.buildingId);
    if (!building) {
      return HttpResponse.json({ detail: "Building not found" }, { status: 404 });
    }
    if (!building.is_archived) {
      return HttpResponse.json(
        { detail: "Only archived buildings can be deleted" },
        { status: 409 }
      );
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(`${BASE}/api/admin/general-meetings/:meetingId`, ({ params }) => {
    if (params.meetingId === "agm1") {
      return HttpResponse.json({ detail: "Cannot delete an open General Meeting" }, { status: 409 });
    }
    if (params.meetingId === "agm-notfound-delete") {
      return HttpResponse.json({ detail: "General Meeting not found" }, { status: 404 });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${BASE}/api/admin/general-meetings/:meetingId/resend-report`, ({ params }) => {
    if (params.meetingId === "agm-resend-fail") {
      return HttpResponse.json({ detail: "Cannot resend" }, { status: 409 });
    }
    const result: ResendReportOut = { queued: true };
    return HttpResponse.json(result);
  }),

  http.put(`${BASE}/api/admin/general-meetings/:meetingId/motions/reorder`, async ({ request, params }) => {
    if (params.meetingId === "agm-closed-reorder") {
      return HttpResponse.json(
        { detail: "Cannot reorder motions on a closed General Meeting" },
        { status: 409 }
      );
    }
    if (params.meetingId === "agm-reorder-error") {
      return HttpResponse.json(
        { detail: "Server error" },
        { status: 500 }
      );
    }
    const body = await request.json() as { motions?: Array<{ motion_id: string; display_order: number }> };
    const incomingMotions = body?.motions ?? [];
    // Sort by display_order and return updated motions using ADMIN_MEETING_DETAIL motions as base
    const sorted = [...incomingMotions].sort((a, b) => a.display_order - b.display_order);
    const baseMotions = ADMIN_MEETING_DETAIL.motions;
    const motionMap = new Map(baseMotions.map((m) => [m.id, m]));
    const reordered: MotionOut[] = sorted.map((item, idx) => {
      const base = motionMap.get(item.motion_id);
      return {
        id: item.motion_id,
        title: base?.title ?? `Motion ${idx + 1}`,
        description: base?.description ?? null,
        display_order: idx + 1,
        motion_number: base?.motion_number ?? null,
        motion_type: base?.motion_type ?? "general",
        is_multi_choice: base?.is_multi_choice ?? false,
        is_visible: base?.is_visible ?? true,
        option_limit: null,
        options: [],
      };
    });
    const result: MotionReorderOut = { motions: reordered };
    return HttpResponse.json(result);
  }),

  http.patch(`${BASE}/api/admin/motions/:motionId/visibility`, async ({ params, request }) => {
    if (params.motionId === "motion-closed") {
      return HttpResponse.json({ detail: "Cannot change visibility on a closed meeting" }, { status: 409 });
    }
    if (params.motionId === "motion-has-votes") {
      return HttpResponse.json({ detail: "Cannot hide a motion that has received votes" }, { status: 409 });
    }
    if (params.motionId === "motion-notfound") {
      return HttpResponse.json({ detail: "Motion not found" }, { status: 404 });
    }
    const body = await request.json() as { is_visible: boolean };
    const motion = ADMIN_MEETING_DETAIL.motions[0];
    return HttpResponse.json({
      ...motion,
      id: params.motionId as string,
      is_visible: body.is_visible,
    });
  }),

  // Add motion
  http.post(`${BASE}/api/admin/general-meetings/:meetingId/motions`, async ({ request }) => {
    const body = await request.json() as { title?: string; description?: string | null; motion_type?: string; is_multi_choice?: boolean; motion_number?: string | null; option_limit?: number | null; options?: Array<{ text: string; display_order: number }> };
    if (body?.title === "add-fail") {
      return HttpResponse.json({ detail: "Cannot add a motion to a closed meeting" }, { status: 409 });
    }
    // Mirror backend behaviour: auto-assign motion_number from display_order when omitted
    const autoDisplayOrder = 3;
    const motionNumber = (body?.motion_number !== undefined && body?.motion_number !== null)
      ? (body.motion_number.trim() || null)
      : String(autoDisplayOrder);
    return HttpResponse.json({
      id: "motion-new",
      title: body?.title ?? "New Motion",
      description: body?.description ?? null,
      display_order: autoDisplayOrder,
      motion_number: motionNumber,
      motion_type: body?.motion_type ?? "general",
      is_multi_choice: body?.is_multi_choice ?? false,
      is_visible: false,
      option_limit: body?.option_limit ?? null,
      options: body?.options ?? [],
    }, { status: 201 });
  }),

  // Update motion
  http.patch(`${BASE}/api/admin/motions/:motionId`, async ({ params, request }) => {
    if (params.motionId === "motion-visible-edit") {
      return HttpResponse.json({ detail: "Cannot edit a visible motion. Hide it first." }, { status: 409 });
    }
    if (params.motionId === "motion-edit-fail") {
      return HttpResponse.json({ detail: "Server error" }, { status: 500 });
    }
    const body = await request.json() as { title?: string; description?: string | null; motion_type?: string; is_multi_choice?: boolean; motion_number?: string | null; option_limit?: number | null; options?: Array<{ text: string; display_order: number }> };
    const motion = ADMIN_MEETING_DETAIL.motions[0];
    return HttpResponse.json({
      ...motion,
      id: params.motionId as string,
      title: body?.title ?? motion.title,
      description: body?.description ?? motion.description,
      motion_type: body?.motion_type ?? motion.motion_type,
      is_multi_choice: body?.is_multi_choice ?? false,
      motion_number: body?.motion_number !== undefined ? body.motion_number : motion.motion_number,
      option_limit: body?.option_limit ?? null,
      options: body?.options ?? [],
    });
  }),

  // Close motion voting
  http.post(`${BASE}/api/admin/motions/:motionId/close`, ({ params }) => {
    if (params.motionId === "motion-hidden-close") {
      return HttpResponse.json({ detail: "Cannot close a hidden motion" }, { status: 409 });
    }
    if (params.motionId === "motion-already-closed") {
      return HttpResponse.json({ detail: "Motion voting is already closed" }, { status: 409 });
    }
    if (params.motionId === "motion-close-not-open") {
      return HttpResponse.json({ detail: "Cannot close motion on a meeting that is not open" }, { status: 409 });
    }
    if (params.motionId === "motion-notfound-close") {
      return HttpResponse.json({ detail: "Motion not found" }, { status: 404 });
    }
    const motion = ADMIN_MEETING_DETAIL.motions[0];
    return HttpResponse.json({
      ...motion,
      id: params.motionId as string,
      voting_closed_at: "2024-06-01T11:00:00Z",
    });
  }),

  // Delete motion
  http.delete(`${BASE}/api/admin/motions/:motionId`, ({ params }) => {
    if (params.motionId === "motion-visible-delete") {
      return HttpResponse.json({ detail: "Cannot delete a visible motion. Hide it first." }, { status: 409 });
    }
    if (params.motionId === "motion-delete-fail") {
      return HttpResponse.json({ detail: "Server error" }, { status: 500 });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // Admin vote entry
  http.post(`${BASE}/api/admin/general-meetings/:meetingId/enter-votes`, async ({ params, request }) => {
    if (params.meetingId === "agm-closed-enter") {
      return HttpResponse.json({ detail: "Meeting is not open" }, { status: 409 });
    }
    if (params.meetingId === "agm-enter-fail") {
      return HttpResponse.json({ detail: "Unknown lot_owner_ids: [\"unknown-lot\"]" }, { status: 422 });
    }
    const body = await request.json() as { entries?: Array<{ lot_owner_id: string }> };
    const count = body?.entries?.length ?? 0;
    return HttpResponse.json({ submitted_count: count, skipped_count: 0 });
  }),

  // Tenant config — admin endpoints
  http.get(`${BASE}/api/admin/config`, () => {
    return HttpResponse.json(configFixture);
  }),

  http.post(`${BASE}/api/admin/config/logo`, () => {
    return HttpResponse.json({ url: "https://public.blob.vercel-storage.com/logo-test.png" });
  }),

  http.post(`${BASE}/api/admin/config/favicon`, () => {
    return HttpResponse.json({ url: "https://public.blob.vercel-storage.com/favicon-test.png" });
  }),

  http.put(`${BASE}/api/admin/config`, async ({ request }) => {
    const body = await request.json() as Partial<TenantConfig>;
    if (!body?.app_name || !body.app_name.trim()) {
      return HttpResponse.json({ detail: "app_name must not be empty" }, { status: 422 });
    }
    if (!body?.primary_colour || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.primary_colour)) {
      return HttpResponse.json({ detail: "primary_colour must be a valid CSS hex colour" }, { status: 422 });
    }
    configFixture = {
      app_name: body.app_name,
      logo_url: body.logo_url ?? "",
      favicon_url: (body as Partial<TenantConfig>).favicon_url ?? null,
      primary_colour: body.primary_colour,
      support_email: body.support_email ?? "",
    };
    return HttpResponse.json(configFixture);
  }),

  // SMTP configuration endpoints
  http.get(`${BASE}/api/admin/config/smtp/status`, () => {
    return HttpResponse.json(smtpStatusFixture);
  }),

  http.get(`${BASE}/api/admin/config/smtp`, () => {
    return HttpResponse.json(smtpConfigFixture);
  }),

  http.put(`${BASE}/api/admin/config/smtp`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (!body?.smtp_host || !(body.smtp_host as string).trim()) {
      return HttpResponse.json({ detail: "smtp_host must not be empty" }, { status: 422 });
    }
    const port = body.smtp_port as number;
    if (!port || port < 1 || port > 65535) {
      return HttpResponse.json({ detail: "smtp_port must be between 1 and 65535" }, { status: 422 });
    }
    const fromEmail = body.smtp_from_email as string;
    if (!fromEmail || !fromEmail.includes("@")) {
      return HttpResponse.json({ detail: "smtp_from_email must be a valid email address" }, { status: 422 });
    }
    const hadPassword = smtpConfigFixture.password_is_set;
    smtpConfigFixture = {
      smtp_host: body.smtp_host as string,
      smtp_port: port,
      smtp_username: (body.smtp_username as string) ?? "",
      smtp_from_email: fromEmail,
      password_is_set: body.smtp_password ? true : hadPassword,
    };
    return HttpResponse.json(smtpConfigFixture);
  }),

  http.post(`${BASE}/api/admin/config/smtp/test`, () => {
    return HttpResponse.json({ ok: true });
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
    { display_order: 1, motion_number: null, title: "Motion 1", description: "Approve the budget" },
    { display_order: 2, motion_number: null, title: "Motion 2", description: null },
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

export const MOTION_ID_MC = "motion-mc-001";

export const motionFixtures = [
  {
    id: MOTION_ID_1,
    title: "Motion 1",
    description: "Approve the budget",
    display_order: 1,
    motion_number: null,
    motion_type: "general" as const,
    is_visible: true,
    already_voted: false,
    submitted_choice: null,
    option_limit: null,
    options: [],
    voting_closed_at: null,
  },
  {
    id: MOTION_ID_2,
    title: "Motion 2",
    description: null,
    display_order: 2,
    motion_number: null,
    motion_type: "general" as const,
    is_visible: true,
    already_voted: false,
    submitted_choice: null,
    option_limit: null,
    options: [],
    voting_closed_at: null,
  },
];

export const mcMotionFixtureVoter = {
  id: MOTION_ID_MC,
  title: "Board Election",
  description: "Vote for board members",
  display_order: 3,
  motion_number: null,
  motion_type: "general" as const,
  is_multi_choice: true,
  is_visible: true,
  already_voted: false,
  submitted_choice: null,
  submitted_option_choices: {} as Record<string, string>,
  option_limit: 2,
  options: [
    { id: "opt-alice", text: "Alice", display_order: 1 },
    { id: "opt-bob", text: "Bob", display_order: 2 },
    { id: "opt-carol", text: "Carol", display_order: 3 },
  ],
};

export const mcBallotVoteFixture = {
  motion_id: MOTION_ID_MC,
  motion_title: "Board Election",
  display_order: 3,
  motion_number: null,
  choice: "selected" as const,
  eligible: true,
  motion_type: "general" as const,
  is_multi_choice: true,
  selected_options: [{ id: "opt-alice", text: "Alice", display_order: 1 }],
  option_choices: [
    { option_id: "opt-alice", option_text: "Alice", choice: "for" },
    { option_id: "opt-bob", option_text: "Bob", choice: "against" },
  ],
};

export const myBallotFixture = {
  voter_email: "owner@example.com",
  meeting_title: "2024 AGM",
  building_name: "Sunset Towers",
  submitted_lots: [
    {
      lot_owner_id: "lo-e2e",
      lot_number: "E2E-1",
      financial_position: "normal",
      submitter_email: "owner@example.com",
      proxy_email: null,
      votes: [
        {
          motion_id: MOTION_ID_1,
          motion_title: "Motion 1",
          display_order: 1,
          motion_number: null,
          choice: "yes" as const,
          eligible: true,
          motion_type: "general" as const,
          is_multi_choice: false,
          selected_options: [],
          option_choices: [],
        },
        {
          motion_id: MOTION_ID_2,
          motion_title: "Motion 2",
          display_order: 2,
          motion_number: null,
          choice: "no" as const,
          eligible: true,
          motion_type: "general" as const,
          is_multi_choice: false,
          selected_options: [],
          option_choices: [],
        },
      ],
    },
  ],
  remaining_lot_owner_ids: [],
};

export const handlers = [
  ...adminHandlers,
  // Tenant config — public endpoint
  http.get(`${BASE}/api/config`, () => {
    return HttpResponse.json(configFixture);
  }),

  http.get(`${BASE}/api/server-time`, () =>
    HttpResponse.json({ utc: "2024-06-01T10:00:00Z" })
  ),

  http.get(`${BASE}/api/buildings`, () =>
    HttpResponse.json([buildingFixture])
  ),

  http.get(`${BASE}/api/buildings/:buildingId/general-meetings`, () =>
    HttpResponse.json([agmOpenFixture, agmClosedFixture])
  ),

  http.post(`${BASE}/api/auth/request-otp`, () =>
    HttpResponse.json({ sent: true })
  ),

  http.post(`${BASE}/api/auth/verify`, () =>
    HttpResponse.json({
      lots: [{ lot_owner_id: "lo-e2e", lot_number: "E2E-1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] }],
      voter_email: "owner@example.com",
      agm_status: "open",
      building_name: "Sunset Towers",
      meeting_title: "2024 AGM",
      unvoted_visible_count: 1,
      session_token: "test-session-token-abc123",
    })
  ),

  http.post(`${BASE}/api/auth/session`, async ({ request, cookies }) => {
    const body = await request.json() as { session_token?: string; general_meeting_id?: string };
    // Accept token from cookie OR body (cookie takes priority)
    const token = cookies["agm_session"] ?? body?.session_token;
    if (token === "invalid-token" || token === "expired-token") {
      return HttpResponse.json({ detail: "Session expired or invalid" }, { status: 401 });
    }
    if (token === "closed-meeting-token") {
      return HttpResponse.json({ detail: "Session expired — meeting is closed" }, { status: 401 });
    }
    return HttpResponse.json({
      lots: [{ lot_owner_id: "lo-e2e", lot_number: "E2E-1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] }],
      voter_email: "owner@example.com",
      agm_status: "open",
      building_name: "Sunset Towers",
      meeting_title: "2024 AGM",
      unvoted_visible_count: 1,
      session_token: "new-session-token-xyz789",
    });
  }),

  http.post(`${BASE}/api/auth/logout`, () =>
    HttpResponse.json({ ok: true })
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
