import { apiFetch } from "./client";
import type { GeneralMeetingStatus, MotionType, VoteChoice } from "../types";

export interface BuildingOut {
  id: string;
  name: string;
}

export interface GeneralMeetingOut {
  id: string;
  title: string;
  status: GeneralMeetingStatus;
  meeting_at: string;
  voting_closes_at: string;
}

export interface OtpRequestBody {
  email: string;
  general_meeting_id: string;
}

export interface OtpRequestResponse {
  sent: boolean;
}

export interface AuthVerifyRequest {
  email: string;
  general_meeting_id: string;
  code: string;
}

export interface LotInfo {
  lot_owner_id: string;
  lot_number: string;
  financial_position: string;
  already_submitted: boolean;
  is_proxy: boolean;
}

export interface AuthVerifyResponse {
  lots: LotInfo[];
  voter_email: string;
  agm_status: string;
  building_name: string;
  meeting_title: string;
}

export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
}

export interface DraftSaveRequest {
  motion_id: string;
  choice: VoteChoice | null;
}

export interface DraftSaveResponse {
  saved: boolean;
}

export interface VoteSummaryItem {
  motion_id: string;
  motion_title: string;
  choice: VoteChoice;
}

export interface LotBallotResult {
  lot_owner_id: string;
  lot_number: string;
  votes: VoteSummaryItem[];
}

export interface SubmitResponse {
  submitted: boolean;
  lots: LotBallotResult[];
}

export interface BallotVoteItem {
  motion_id: string;
  motion_title: string;
  order_index: number;
  choice: VoteChoice;
  eligible: boolean;
}

export interface LotBallotSummary {
  lot_owner_id: string;
  lot_number: string;
  financial_position: string;
  votes: BallotVoteItem[];
}

export interface MyBallotResponse {
  voter_email: string;
  meeting_title: string;
  building_name: string;
  submitted_lots: LotBallotSummary[];
  remaining_lot_owner_ids: string[];
}

export interface SubmitBallotRequest {
  lot_owner_ids: string[];
  votes: Array<{ motion_id: string; choice: string }>;
}

export interface ServerTimeResponse {
  utc: string;
}

export function fetchServerTime(): Promise<ServerTimeResponse> {
  return apiFetch<ServerTimeResponse>("/api/server-time");
}

export function fetchBuildings(): Promise<BuildingOut[]> {
  return apiFetch<BuildingOut[]>("/api/buildings");
}

export function fetchGeneralMeetings(buildingId: string): Promise<GeneralMeetingOut[]> {
  return apiFetch<GeneralMeetingOut[]>(`/api/buildings/${buildingId}/general-meetings`);
}

export function requestOtp(req: OtpRequestBody): Promise<OtpRequestResponse> {
  return apiFetch<OtpRequestResponse>("/api/auth/request-otp", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function verifyAuth(req: AuthVerifyRequest): Promise<AuthVerifyResponse> {
  return apiFetch<AuthVerifyResponse>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function fetchMotions(meetingId: string): Promise<MotionOut[]> {
  return apiFetch<MotionOut[]>(`/api/general-meeting/${meetingId}/motions`);
}

export function saveDraft(meetingId: string, req: DraftSaveRequest): Promise<DraftSaveResponse> {
  return apiFetch<DraftSaveResponse>(`/api/general-meeting/${meetingId}/draft`, {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

export function submitBallot(meetingId: string, request: SubmitBallotRequest): Promise<SubmitResponse> {
  return apiFetch<SubmitResponse>(`/api/general-meeting/${meetingId}/submit`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export function fetchMyBallot(meetingId: string): Promise<MyBallotResponse> {
  return apiFetch<MyBallotResponse>(`/api/general-meeting/${meetingId}/my-ballot`);
}
