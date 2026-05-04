// TypeScript types matching backend SQLAlchemy models

export type GeneralMeetingStatus = "open" | "closed" | "pending";
export type VoteChoice = "yes" | "no" | "abstained" | "not_eligible" | "selected";
export type VoteStatus = "draft" | "submitted";
export type EmailDeliveryStatus = "pending" | "delivered" | "failed";
export type MotionType = "general" | "special";
export type FinancialPosition = "normal" | "in_arrear";

export interface Building {
  id: string;
  name: string;
  manager_email: string;
  is_archived: boolean;
  unarchive_count: number;
  created_at: string;
}

export interface LotOwnerEmailEntry {
  id: string;
  email: string | null;
  given_name: string | null;
  surname: string | null;
}

export interface LotOwner {
  id: string;
  building_id: string;
  lot_number: string;
  given_name: string | null;
  surname: string | null;
  owner_emails: LotOwnerEmailEntry[];
  emails: string[];
  unit_entitlement: number;
  financial_position: FinancialPosition;
  proxy_email: string | null;
  proxy_given_name: string | null;
  proxy_surname: string | null;
  phone_number: string | null;
}

export interface GeneralMeeting {
  id: string;
  building_id: string;
  title: string;
  status: GeneralMeetingStatus;
  meeting_at: string;
  voting_closes_at: string;
  created_at: string;
  closed_at: string | null;
}

export interface Motion {
  id: string;
  general_meeting_id: string;
  title: string;
  description: string | null;
  display_order: number;
  motion_number: string | null;
  motion_type: MotionType;
  is_multi_choice: boolean;
}

export interface GeneralMeetingLotWeight {
  id: string;
  general_meeting_id: string;
  lot_owner_id: string;
  voter_email: string;
  unit_entitlement_snapshot: number;
}

export interface Vote {
  id: string;
  general_meeting_id: string;
  motion_id: string;
  voter_email: string;
  choice: VoteChoice | null;
  status: VoteStatus;
  created_at: string;
  updated_at: string;
}

export interface BallotSubmission {
  id: string;
  general_meeting_id: string;
  voter_email: string;
  submitted_at: string;
}

export interface SessionRecord {
  id: string;
  session_token: string;
  voter_email: string;
  building_id: string;
  general_meeting_id: string;
  created_at: string;
  expires_at: string;
}

export interface EmailDelivery {
  id: string;
  general_meeting_id: string;
  status: EmailDeliveryStatus;
  total_attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}
