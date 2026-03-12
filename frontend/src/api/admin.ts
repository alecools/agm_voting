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
  order_index: number;
  motion_type: MotionType;
}

export interface AGMOut {
  id: string;
  building_id: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  motions: MotionOut[];
}

export interface AGMListItem {
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
  lot_number: string;
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
  order_index: number;
  motion_type: MotionType;
  tally: MotionTally;
  voter_lists: MotionVoterLists;
}

export interface AGMDetail {
  id: string;
  building_name: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  closed_at: string | null;
  total_eligible_voters: number;
  total_submitted: number;
  motions: MotionDetail[];
}

export interface AGMCloseOut {
  id: string;
  status: string;
  closed_at: string;
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

export interface MotionCreateRequest {
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
}

export interface AGMCreateRequest {
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
// AGMs
// ---------------------------------------------------------------------------

export async function listAGMs(): Promise<AGMListItem[]> {
  return apiFetch<AGMListItem[]>("/api/admin/agms");
}

export async function createAGM(data: AGMCreateRequest): Promise<AGMOut> {
  return apiFetch<AGMOut>("/api/admin/agms", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getAGMDetail(agmId: string): Promise<AGMDetail> {
  return apiFetch<AGMDetail>(`/api/admin/agms/${agmId}`);
}

export async function closeAGM(agmId: string): Promise<AGMCloseOut> {
  return apiFetch<AGMCloseOut>(`/api/admin/agms/${agmId}/close`, {
    method: "POST",
  });
}

export async function resendReport(agmId: string): Promise<ResendReportOut> {
  return apiFetch<ResendReportOut>(`/api/admin/agms/${agmId}/resend-report`, {
    method: "POST",
  });
}
