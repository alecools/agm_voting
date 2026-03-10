import { apiFetch } from "./client";
import type { Building, LotOwner } from "../types";

// ---------------------------------------------------------------------------
// Response types (matching backend schemas)
// ---------------------------------------------------------------------------

export interface BuildingImportResult {
  created: number;
  updated: number;
}

export interface LotOwnerImportResult {
  imported: number;
}

export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
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
  voter_email: string;
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
}

export interface MotionVoterLists {
  yes: VoterEntry[];
  no: VoterEntry[];
  abstained: VoterEntry[];
  absent: VoterEntry[];
}

export interface MotionDetail {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
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
  email: string;
  unit_entitlement: number;
}

export interface LotOwnerUpdateRequest {
  email?: string;
  unit_entitlement?: number;
}

export interface MotionCreateRequest {
  title: string;
  description: string | null;
  order_index: number;
}

export interface AGMCreateRequest {
  building_id: string;
  title: string;
  meeting_at: string;
  voting_closes_at: string;
  motions: MotionCreateRequest[];
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export async function listBuildings(): Promise<Building[]> {
  return apiFetch<Building[]>("/api/admin/buildings");
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
