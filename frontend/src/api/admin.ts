import { apiFetch, apiFetchVoid } from "./client";
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

export interface MotionOptionCreate {
  text: string;
  display_order: number;
}

export interface MotionOptionOut {
  id: string;
  text: string;
  display_order: number;
}

export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
  is_multi_choice?: boolean;
  is_visible: boolean;
  option_limit: number | null;
  options: MotionOptionOut[];
  voting_closed_at?: string | null;
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
  voter_name?: string | null;
  lot_number?: string;
  entitlement: number;
  proxy_email?: string | null;
  submitted_by_admin?: boolean;
  submitted_at?: string | null;
}

export interface TallyCategory {
  voter_count: number;
  entitlement_sum: number;
}

export interface OptionTallyEntry {
  option_id: string;
  option_text: string;
  display_order: number;
  // Primary tally fields (For/Against/Abstained) — Slice 10: US-MC-ADMIN-01
  for_voter_count?: number;
  for_entitlement_sum?: number;
  against_voter_count?: number;
  against_entitlement_sum?: number;
  abstained_voter_count?: number;
  abstained_entitlement_sum?: number;
  // Backward-compatible aliases (deprecated, kept for one release)
  voter_count: number;
  entitlement_sum: number;
  outcome: string | null;
}

export interface MotionTally {
  yes: TallyCategory;
  no: TallyCategory;
  abstained: TallyCategory;
  absent: TallyCategory;
  not_eligible: TallyCategory;
  options: OptionTallyEntry[];
}

export interface MotionVoterLists {
  yes: VoterEntry[];
  no: VoterEntry[];
  abstained: VoterEntry[];
  absent: VoterEntry[];
  not_eligible: VoterEntry[];
  // Per-option voter lists by category (Slice 10: US-MC-ADMIN-01)
  options_for?: Record<string, VoterEntry[]>;
  options_against?: Record<string, VoterEntry[]>;
  options_abstained?: Record<string, VoterEntry[]>;
  // Backward-compatible alias for options_for
  options: Record<string, VoterEntry[]>;
}

export interface MotionDetail {
  id: string;
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
  is_multi_choice?: boolean;
  is_visible: boolean;
  option_limit: number | null;
  options: MotionOptionOut[];
  voting_closed_at: string | null;
  tally: MotionTally;
  voter_lists: MotionVoterLists;
}

export interface GeneralMeetingDetail {
  id: string;
  building_id?: string;
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
  email_delivery?: EmailDeliveryInfo | null;
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
  given_name?: string | null;
  surname?: string | null;
  emails: string[];
  unit_entitlement: number;
  financial_position?: string;
}

export interface LotOwnerUpdateRequest {
  given_name?: string | null;
  surname?: string | null;
  unit_entitlement?: number;
  financial_position?: string;
}

export interface AddEmailRequest {
  email: string;
}

export interface AddOwnerEmailRequest {
  email: string;
  given_name?: string | null;
  surname?: string | null;
  phone_number?: string | null;
}

export interface UpdateOwnerEmailRequest {
  email?: string | null;
  given_name?: string | null;
  surname?: string | null;
  phone_number?: string | null;
}

export async function addOwnerEmailToLotOwner(
  lotOwnerId: string,
  data: AddOwnerEmailRequest
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/owner-emails`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateOwnerEmail(
  lotOwnerId: string,
  emailId: string,
  data: UpdateOwnerEmailRequest
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/owner-emails/${emailId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function removeOwnerEmailById(
  lotOwnerId: string,
  emailId: string
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/owner-emails/${emailId}`, {
    method: "DELETE",
  });
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
  proxyEmail: string,
  givenName?: string | null,
  surname?: string | null,
): Promise<LotOwner> {
  return apiFetch<LotOwner>(`/api/admin/lot-owners/${lotOwnerId}/proxy`, {
    method: "PUT",
    body: JSON.stringify({ proxy_email: proxyEmail, given_name: givenName, surname }),
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
  is_multi_choice?: boolean;
  option_limit?: number | null;
  options?: MotionOptionCreate[];
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

export interface ListBuildingsParams {
  limit?: number;
  offset?: number;
  name?: string;
  is_archived?: boolean;
  sort_by?: "name" | "manager_email" | "created_at" | string;
  sort_dir?: "asc" | "desc";
}

export async function listBuildings(params?: ListBuildingsParams): Promise<Building[]> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));
  if (params?.name !== undefined) qs.set("name", params.name);
  if (params?.is_archived !== undefined) qs.set("is_archived", String(params.is_archived));
  if (params?.sort_by !== undefined) qs.set("sort_by", params.sort_by);
  if (params?.sort_dir !== undefined) qs.set("sort_dir", params.sort_dir);
  const query = qs.toString();
  return apiFetch<Building[]>(`/api/admin/buildings${query ? `?${query}` : ""}`);
}

export async function getBuildingsCount(params?: { name?: string; is_archived?: boolean }): Promise<{ count: number }> {
  const qs = new URLSearchParams();
  if (params?.name !== undefined) qs.set("name", params.name);
  if (params?.is_archived !== undefined) qs.set("is_archived", String(params.is_archived));
  const query = qs.toString();
  return apiFetch<{ count: number }>(`/api/admin/buildings/count${query ? `?${query}` : ""}`);
}

export async function getBuilding(buildingId: string): Promise<Building> {
  return apiFetch<Building>(`/api/admin/buildings/${buildingId}`);
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

export async function importBuildings(file: File): Promise<BuildingImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<BuildingImportResult>("/api/admin/buildings/import", {
    method: "POST",
    body: formData,
  });
}

// ---------------------------------------------------------------------------
// Lot owners
// ---------------------------------------------------------------------------

export async function listLotOwners(
  buildingId: string,
  params?: { limit?: number; offset?: number; sort_by?: string; sort_dir?: string }
): Promise<LotOwner[]> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));
  if (params?.sort_by !== undefined) qs.set("sort_by", params.sort_by);
  if (params?.sort_dir !== undefined) qs.set("sort_dir", params.sort_dir);
  const query = qs.toString();
  return apiFetch<LotOwner[]>(
    `/api/admin/buildings/${buildingId}/lot-owners${query ? `?${query}` : ""}`
  );
}

export async function countLotOwners(buildingId: string): Promise<number> {
  const data = await apiFetch<{ count: number }>(
    `/api/admin/buildings/${buildingId}/lot-owners/count`
  );
  return data.count;
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
  return apiFetch<LotOwnerImportResult>(
    `/api/admin/buildings/${buildingId}/lot-owners/import`,
    { method: "POST", body: formData }
  );
}

export async function importProxyNominations(
  buildingId: string,
  file: File
): Promise<ProxyImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<ProxyImportResult>(
    `/api/admin/buildings/${buildingId}/lot-owners/import-proxies`,
    { method: "POST", body: formData }
  );
}

export async function importFinancialPositions(
  buildingId: string,
  file: File
): Promise<FinancialPositionImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<FinancialPositionImportResult>(
    `/api/admin/buildings/${buildingId}/lot-owners/import-financial-positions`,
    { method: "POST", body: formData }
  );
}

// ---------------------------------------------------------------------------
// General Meetings
// ---------------------------------------------------------------------------

export interface ListGeneralMeetingsParams {
  limit?: number;
  offset?: number;
  name?: string;
  building_id?: string;
  status?: string;
  sort_by?: "title" | "created_at" | "meeting_at" | "voting_closes_at" | "status" | string;
  sort_dir?: "asc" | "desc";
}

export async function listGeneralMeetings(params?: ListGeneralMeetingsParams): Promise<GeneralMeetingListItem[]> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.offset !== undefined) qs.set("offset", String(params.offset));
  if (params?.name !== undefined) qs.set("name", params.name);
  if (params?.building_id !== undefined) qs.set("building_id", params.building_id);
  if (params?.status !== undefined) qs.set("status", params.status);
  if (params?.sort_by !== undefined) qs.set("sort_by", params.sort_by);
  if (params?.sort_dir !== undefined) qs.set("sort_dir", params.sort_dir);
  const query = qs.toString();
  return apiFetch<GeneralMeetingListItem[]>(`/api/admin/general-meetings${query ? `?${query}` : ""}`);
}

export async function getGeneralMeetingsCount(params?: { name?: string; building_id?: string; status?: string }): Promise<{ count: number }> {
  const qs = new URLSearchParams();
  if (params?.name !== undefined) qs.set("name", params.name);
  if (params?.building_id !== undefined) qs.set("building_id", params.building_id);
  if (params?.status !== undefined) qs.set("status", params.status);
  const query = qs.toString();
  return apiFetch<{ count: number }>(`/api/admin/general-meetings/count${query ? `?${query}` : ""}`);
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
  return apiFetchVoid(`/api/admin/general-meetings/${meetingId}`, {
    method: "DELETE",
  });
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

export async function deleteBuilding(buildingId: string): Promise<void> {
  return apiFetchVoid(`/api/admin/buildings/${buildingId}`, {
    method: "DELETE",
  });
}

export async function toggleMotionVisibility(
  motionId: string,
  isVisible: boolean,
): Promise<MotionDetail> {
  return apiFetch<MotionDetail>(`/api/admin/motions/${motionId}/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_visible: isVisible }),
  });
}

export interface MotionVisibilityOut {
  id: string;
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
  is_multi_choice?: boolean;
  is_visible: boolean;
  option_limit: number | null;
  options: MotionOptionOut[];
}

export interface AddMotionRequest {
  title: string;
  description: string | null;
  motion_type: MotionType;
  is_multi_choice?: boolean;
  motion_number?: string | null;
  option_limit?: number | null;
  options?: MotionOptionCreate[];
}

export interface UpdateMotionRequest {
  title?: string;
  description?: string | null;
  motion_type?: MotionType;
  is_multi_choice?: boolean;
  motion_number?: string | null;
  option_limit?: number | null;
  options?: MotionOptionCreate[];
}

export async function addMotionToMeeting(
  meetingId: string,
  data: AddMotionRequest,
): Promise<MotionOut> {
  return apiFetch<MotionOut>(`/api/admin/general-meetings/${meetingId}/motions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateMotion(
  motionId: string,
  data: UpdateMotionRequest,
): Promise<MotionVisibilityOut> {
  return apiFetch<MotionVisibilityOut>(`/api/admin/motions/${motionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteMotion(motionId: string): Promise<void> {
  return apiFetchVoid(`/api/admin/motions/${motionId}`, {
    method: "DELETE",
  });
}

export async function closeMotion(motionId: string): Promise<MotionDetail> {
  return apiFetch<MotionDetail>(`/api/admin/motions/${motionId}/close`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Admin in-person vote entry (US-AVE-01/02/03)
// ---------------------------------------------------------------------------

export interface AdminVoteEntryItem {
  motion_id: string;
  choice: "yes" | "no" | "abstained";
}

/** US-AVE2-01: per-option For/Against/Abstain choice for admin vote entry */
export interface AdminMultiChoiceOptionChoice {
  option_id: string;
  choice: "for" | "against" | "abstained";
}

export interface AdminMultiChoiceVoteItem {
  motion_id: string;
  /** New format (US-AVE2-01): per-option choices */
  option_choices: AdminMultiChoiceOptionChoice[];
}

export interface AdminVoteEntryLot {
  lot_owner_id: string;
  votes: AdminVoteEntryItem[];
  multi_choice_votes: AdminMultiChoiceVoteItem[];
}

export interface AdminVoteEntryRequest {
  entries: AdminVoteEntryLot[];
}

export interface AdminVoteEntryResult {
  submitted_count: number;
  skipped_count: number;
}

export async function enterInPersonVotes(
  meetingId: string,
  request: AdminVoteEntryRequest
): Promise<AdminVoteEntryResult> {
  return apiFetch<AdminVoteEntryResult>(
    `/api/admin/general-meetings/${meetingId}/enter-votes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }
  );
}
