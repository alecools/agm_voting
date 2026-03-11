import { apiFetch } from "./client";
import type { AGMStatus, MotionType, VoteChoice } from "../types";

export interface BuildingOut {
  id: string;
  name: string;
}

export interface AGMOut {
  id: string;
  title: string;
  status: AGMStatus;
  meeting_at: string;
  voting_closes_at: string;
}

export interface AuthVerifyRequest {
  lot_number: string;
  email: string;
  building_id: string;
  agm_id: string;
}

export interface AuthVerifyResponse {
  already_submitted: boolean;
  voter_email: string;
  agm_status: string;
}

export interface MotionOut {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
}

export interface DraftItem {
  motion_id: string;
  choice: VoteChoice;
}

export interface DraftsResponse {
  drafts: DraftItem[];
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

export interface SubmitResponse {
  submitted: boolean;
  votes: VoteSummaryItem[];
}

export interface BallotVoteItem {
  motion_id: string;
  motion_title: string;
  order_index: number;
  choice: VoteChoice;
}

export interface MyBallotResponse {
  voter_email: string;
  agm_title: string;
  building_name: string;
  votes: BallotVoteItem[];
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

export function fetchAGMs(buildingId: string): Promise<AGMOut[]> {
  return apiFetch<AGMOut[]>(`/api/buildings/${buildingId}/agms`);
}

export function verifyAuth(req: AuthVerifyRequest): Promise<AuthVerifyResponse> {
  return apiFetch<AuthVerifyResponse>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function fetchMotions(agmId: string): Promise<MotionOut[]> {
  return apiFetch<MotionOut[]>(`/api/agm/${agmId}/motions`);
}

export function fetchDrafts(agmId: string): Promise<DraftsResponse> {
  return apiFetch<DraftsResponse>(`/api/agm/${agmId}/drafts`);
}

export function saveDraft(agmId: string, req: DraftSaveRequest): Promise<DraftSaveResponse> {
  return apiFetch<DraftSaveResponse>(`/api/agm/${agmId}/draft`, {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

export function submitBallot(agmId: string): Promise<SubmitResponse> {
  return apiFetch<SubmitResponse>(`/api/agm/${agmId}/submit`, {
    method: "POST",
  });
}

export function fetchMyBallot(agmId: string): Promise<MyBallotResponse> {
  return apiFetch<MyBallotResponse>(`/api/agm/${agmId}/my-ballot`);
}
