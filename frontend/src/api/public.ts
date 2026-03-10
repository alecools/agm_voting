import { apiFetch } from "./client";

export interface AGMSummaryMotion {
  order_index: number;
  title: string;
  description: string | null;
}

export interface AGMSummaryData {
  agm_id: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  building_name: string;
  motions: AGMSummaryMotion[];
}

export function getAGMSummary(agmId: string): Promise<AGMSummaryData> {
  return apiFetch<AGMSummaryData>(`/api/agm/${agmId}/summary`);
}
