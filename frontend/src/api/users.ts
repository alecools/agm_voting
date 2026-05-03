import { apiFetch, apiFetchVoid } from "./client";

export interface AdminUser {
  id: string;
  email: string;
  created_at: string; // ISO 8601 UTC
}

export interface AdminUserListResponse {
  users: AdminUser[];
}

export async function listAdminUsers(): Promise<AdminUserListResponse> {
  return apiFetch<AdminUserListResponse>("/api/admin/users");
}

export async function inviteAdminUser(email: string): Promise<AdminUser> {
  return apiFetch<AdminUser>("/api/admin/users/invite", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function removeAdminUser(userId: string): Promise<void> {
  return apiFetchVoid(`/api/admin/users/${userId}`, {
    method: "DELETE",
  });
}
