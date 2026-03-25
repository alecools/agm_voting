import { apiFetch } from "./client";
import type { Building, LotOwner, MotionType } from "../types";

// ---------------------------------------------------------------------------
// Response types (matching backend schemas)
// ---------------------------------------------------------------------------

export interface BuildingImportResult {
  created: number;
  updated: number;
}

export interface LotOwnerImportResult {
  imported: number;
  emails: number;
}

export interface ProxyImportResult {
  upserted: number;
  removed: number;
  skipped: number;
}

export interface FinancialPositionImportResult {
  updated: number;
  skipped: number;
}

export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
}

export interface GeneralMeetingOut {
  id: string;
  building_id: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  motions: MotionOut[];
}

export interface GeneralMeetingListItem {
  id: string;
  building_id: string;
  building_name: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  created_at: string;
}

export interface VoterEntry {
  voter_email?: string;
  lot_number?: string;
  entitlement: number;
}

export interface TallyCategory {
  voter_count: number;
  entitlement_sum: number;
}

export interface MotionTally {
  yes: TallyCategory;
  no: TallyCategory;
  abstained: TallyCategory;
  absent: TallyCategory;
  not_eligible: TallyCategory;
}

export interface MotionVoterLists {
  yes: VoterEntry[];
  no: VoterEntry[];
  abstained: VoterEntry[];
  absent: VoterEntry[];
  not_eligible: VoterEntry[];
}

export interface MotionDetail {
  id: string;
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
  tally: MotionTally;
  voter_lists: MotionVoterLists;
}

export interface GeneralMeetingDetail {
  id: string;
  building_name: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  closed_at: string | null;
  total_eligible_voters: number;
  total_submitted: number;
  total_entitlement: number;
  motions: MotionDetail[];
}

export interface GeneralMeetingCloseOut {
  id: string;
  status: string;
  closed_at: string;
}

export interface GeneralMeetingStartOut {
  id: string;
  status: string;
  meeting_at: string;
}

export interface ResendReportOut {
  queued: boolean;
}

export interface EmailDeliveryInfo {
  status: string;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface LotOwnerCreateRequest {
  lot_number: string;
  emails: string[];
  unit_entitlement: number;
  financial_position?: string;
}

export interface LotOwnerUpdateRequest {
  unit_entitlement?: number;
  financial_position?: string;
}

export interface AddEmailRequest {
  email: string;
}

export async function addEmailToLotOwner(
  lotOwnerId: string,
  email: string
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/emails`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function removeEmailFromLotOwner(
  lotOwnerId: string,
  email: string
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/emails/${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
}

export async function setLotOwnerProxy(
  lotOwnerId: string,
  proxyEmail: string
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/proxy`, {
    method: "PUT",
    body: JSON.stringify({ proxy_email: proxyEmail }),
  });
}

export async function removeLotOwnerProxy(
  lotOwnerId: string
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/proxy`, {
    method: "DELETE",
  });
}

export interface MotionCreateRequest {
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
}

export interface GeneralMeetingCreateRequest {
  building_id: string;
  title: string;
  meeting_at: string;
  voting_closes_at: string;
  motions: MotionCreateRequest[];
}

// ---------------------------------------------------------------------------
// Request types (continued)
// ---------------------------------------------------------------------------

export interface BuildingCreateRequest {
  name: string;
  manager_email: string;
}

export interface BuildingUpdateRequest {
  name?: string;
  manager_email?: string;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface BuildingArchiveOut {
  id: string;
  name: string;
  is_archived: boolean;
}

export interface AdminLoginRequest {
  username: string;
  password: string;
}

export interface AdminMeOut {
  authenticated: boolean;
}

export async function listBuildings(): Promise<Building[]> {
  return apiFetch<Building[]>("/api/admin/buildings");
}

export async function createBuilding(data: BuildingCreateRequest): Promise<Building> {
  return apiFetch<Building>("/api/admin/buildings", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function archiveBuilding(buildingId: string): Promise<BuildingArchiveOut> {
  return apiFetch<BuildingArchiveOut>(`/api/admin/buildings/${buildingId}/archive`, {
    method: "POST",
  });
}

export async function updateBuilding(buildingId: string, data: BuildingUpdateRequest): Promise<Building> {
  return apiFetch<Building>(`/api/admin/buildings/${buildingId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function adminLogin(data: AdminLoginRequest): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/admin/auth/login", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function adminLogout(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/admin/auth/logout", {
    method: "POST",
  });
}

export async function adminGetMe(): Promise<AdminMeOut> {
  return apiFetch<AdminMeOut>("/api/admin/auth/me");
}

export async function importBuildings(file: File): Promise<BuildingImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"}/api/admin/buildings/import`,
    {
      method: "POST",
      body: formData,
      credentials: "include",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<BuildingImportResult>;
}

// ---------------------------------------------------------------------------
// Lot owners
// ---------------------------------------------------------------------------

export async function listLotOwners(buildingId: string): Promise<LotOwner[]> {
  return apiFetch<LotOwner[]>(`/api/admin/buildings/${buildingId}/lot-owners`);
}

export async function getLotOwner(lotOwnerId: string): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}`);
}

export async function addLotOwner(
  buildingId: string,
  data: LotOwnerCreateRequest
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/buildings/${buildingId}/lot-owners`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateLotOwner(
  lotOwnerId: string,
  data: LotOwnerUpdateRequest
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function importLotOwners(
  buildingId: string,
  file: File
): Promise<LotOwnerImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"}/api/admin/buildings/${buildingId}/lot-owners/import`,
    {
      method: "POST",
      body: formData,
      credentials: "include",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<LotOwnerImportResult>;
}

export async function importProxyNominations(
  buildingId: string,
  file: File
): Promise<ProxyImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"}/api/admin/buildings/${buildingId}/lot-owners/import-proxies`,
    {
      method: "POST",
      body: formData,
      credentials: "include",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<ProxyImportResult>;
}

export async function importFinancialPositions(
  buildingId: string,
  file: File
): Promise<FinancialPositionImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"}/api/admin/buildings/${buildingId}/lot-owners/import-financial-positions`,
    {
      method: "POST",
      body: formData,
      credentials: "include",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<FinancialPositionImportResult>;
}

// ---------------------------------------------------------------------------
// General Meetings
// ---------------------------------------------------------------------------

export async function listGeneralMeetings(): Promise<GeneralMeetingListItem[]> {
  return apiFetch<GeneralMeetingListItem[]>("/api/admin/general-meetings");
}

export async function createGeneralMeeting(data: GeneralMeetingCreateRequest): Promise<GeneralMeetingOut> {
  return apiFetch<GeneralMeetingOut>("/api/admin/general-meetings", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getGeneralMeetingDetail(meetingId: string): Promise<GeneralMeetingDetail> {
  return apiFetch<GeneralMeetingDetail>(`/api/admin/general-meetings/${meetingId}`);
}

export async function closeGeneralMeeting(meetingId: string): Promise<GeneralMeetingCloseOut> {
  return apiFetch<GeneralMeetingCloseOut>(`/api/admin/general-meetings/${meetingId}/close`, {
    method: "POST",
  });
}

export async function startGeneralMeeting(meetingId: string): Promise<GeneralMeetingStartOut> {
  return apiFetch<GeneralMeetingStartOut>(`/api/admin/general-meetings/${meetingId}/start`, {
    method: "POST",
  });
}

export async function resendReport(meetingId: string): Promise<ResendReportOut> {
  return apiFetch<ResendReportOut>(`/api/admin/general-meetings/${meetingId}/resend-report`, {
    method: "POST",
  });
}

export async function deleteGeneralMeeting(meetingId: string): Promise<void> {
  const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
  const res = await fetch(`${BASE_URL}/api/admin/general-meetings/${meetingId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to delete meeting: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Motion reorder
// ---------------------------------------------------------------------------

export interface MotionReorderItem {
  motion_id: string;
  display_order: number;
}

export interface MotionReorderOut {
  motions: MotionOut[];
}

export async function reorderMotions(
  meetingId: string,
  motions: MotionReorderItem[]
): Promise<MotionReorderOut> {
  return apiFetch<MotionReorderOut>(
    `/api/admin/general-meetings/${meetingId}/motions/reorder`,
    {
      method: "PUT",
      body: JSON.stringify({ motions }),
    }
  );
}
