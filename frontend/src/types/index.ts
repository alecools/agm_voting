// TypeScript types matching backend SQLAlchemy models

export type AGMStatus = "open" | "closed";
export type VoteChoice = "yes" | "no" | "abstained" | "not_eligible";
export type VoteStatus = "draft" | "submitted";
export type EmailDeliveryStatus = "pending" | "delivered" | "failed";
export type MotionType = "general" | "special";
export type FinancialPosition = "normal" | "in_arrear";

export interface Building {
  id: string;
  name: string;
  manager_email: string;
  is_archived: boolean;
  created_at: string;
}

export interface LotOwner {
  id: string;
  building_id: string;
  lot_number: string;
  emails: string[];
  unit_entitlement: number;
  financial_position: FinancialPosition;
  proxy_email: string | null;
}

export interface AGM {
  id: string;
  building_id: string;
  title: string;
  status: AGMStatus;
  meeting_at: string;
  voting_closes_at: string;
  created_at: string;
  closed_at: string | null;
}

export interface Motion {
  id: string;
  agm_id: string;
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
}

export interface AGMLotWeight {
  id: string;
  agm_id: string;
  lot_owner_id: string;
  voter_email: string;
  unit_entitlement_snapshot: number;
}

export interface Vote {
  id: string;
  agm_id: string;
  motion_id: string;
  voter_email: string;
  choice: VoteChoice | null;
  status: VoteStatus;
  created_at: string;
  updated_at: string;
}

export interface BallotSubmission {
  id: string;
  agm_id: string;
  voter_email: string;
  submitted_at: string;
}

export interface SessionRecord {
  id: string;
  session_token: string;
  voter_email: string;
  building_id: string;
  agm_id: string;
  created_at: string;
  expires_at: string;
}

export interface EmailDelivery {
  id: string;
  agm_id: string;
  status: EmailDeliveryStatus;
  total_attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}
