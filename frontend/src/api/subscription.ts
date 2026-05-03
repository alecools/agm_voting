import { apiFetch } from "./client";
import type { BuildingArchiveOut } from "./admin";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubscriptionResponse {
  tier_name: string | null;
  building_limit: number | null;
  active_building_count: number;
}

export interface SubscriptionUpdate {
  tier_name: string | null;
  building_limit: number | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getSubscription(): Promise<SubscriptionResponse> {
  return apiFetch<SubscriptionResponse>("/api/admin/subscription");
}

export async function updateSubscription(
  data: SubscriptionUpdate
): Promise<SubscriptionResponse> {
  return apiFetch<SubscriptionResponse>("/api/admin/subscription", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function unarchiveBuilding(id: string): Promise<BuildingArchiveOut> {
  return apiFetch<BuildingArchiveOut>(`/api/admin/buildings/${id}/unarchive`, {
    method: "POST",
  });
}
