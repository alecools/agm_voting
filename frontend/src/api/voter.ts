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
  voted_motion_ids: string[];  // motion IDs with submitted votes for this lot
}

export interface AuthVerifyResponse {
  lots: LotInfo[];
  voter_email: string;
  agm_status: string;
  building_name: string;
  meeting_title: string;
  unvoted_visible_count: number;
  session_token: string;
}

export interface SessionRestoreRequest {
  general_meeting_id: string;
  session_token?: string;
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
  already_voted: boolean;
  submitted_choice: VoteChoice | null;
  /** option_id → choice string ("for" | "against" | "abstained") */
  submitted_option_choices?: Record<string, string>;
  option_limit: number | null;
  options: MotionOptionOut[];
  voting_closed_at?: string | null;
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

export interface BallotOptionChoiceItem {
  option_id: string;
  option_text: string;
  choice: string;  // "for" | "against" | "abstained"
}

export interface BallotVoteItem {
  motion_id: string;
  motion_title: string;
  display_order: number;
  motion_number: string | null;
  choice: VoteChoice;
  eligible: boolean;
  motion_type: MotionType;
  is_multi_choice?: boolean;
  selected_options: MotionOptionOut[];
  option_choices: BallotOptionChoiceItem[];
}

export interface LotBallotSummary {
  lot_owner_id: string;
  lot_number: string;
  financial_position: string;
  votes: BallotVoteItem[];
  submitter_email: string;
  proxy_email?: string | null;
}

export interface MyBallotResponse {
  voter_email: string;
  meeting_title: string;
  building_name: string;
  submitted_lots: LotBallotSummary[];
  remaining_lot_owner_ids: string[];
}

export interface MultiChoiceOptionChoice {
  option_id: string;
  choice: "for" | "against" | "abstained";
}

export interface MultiChoiceVoteItem {
  motion_id: string;
  option_choices: MultiChoiceOptionChoice[];
}

export interface SubmitBallotRequest {
  lot_owner_ids: string[];
  votes: Array<{ motion_id: string; choice: VoteChoice }>;
  multi_choice_votes?: MultiChoiceVoteItem[];
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

export function restoreSession(req: SessionRestoreRequest): Promise<AuthVerifyResponse> {
  return apiFetch<AuthVerifyResponse>("/api/auth/session", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/auth/logout", {
    method: "POST",
  });
}
