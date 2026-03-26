import { apiFetch } from "./client";

export interface GeneralMeetingSummaryMotion {
  display_order: number;
  motion_number: string | null;
  title: string;
  description: string | null;
}

export interface GeneralMeetingSummaryData {
  general_meeting_id: string;
  building_id: string;
  title: string;
  status: string;
  meeting_at: string;
  voting_closes_at: string;
  building_name: string;
  motions: GeneralMeetingSummaryMotion[];
}

export function getGeneralMeetingSummary(meetingId: string): Promise<GeneralMeetingSummaryData> {
  return apiFetch<GeneralMeetingSummaryData>(`/api/general-meeting/${meetingId}/summary`);
}
