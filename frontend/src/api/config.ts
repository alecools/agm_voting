import { apiFetch } from "./client";

export interface TenantConfig {
  app_name: string;
  logo_url: string;
  primary_colour: string;
  support_email: string;
}

export async function getPublicConfig(): Promise<TenantConfig> {
  return apiFetch<TenantConfig>("/api/config");
}

export async function getAdminConfig(): Promise<TenantConfig> {
  return apiFetch<TenantConfig>("/api/admin/config");
}

export async function updateAdminConfig(data: TenantConfig): Promise<TenantConfig> {
  return apiFetch<TenantConfig>("/api/admin/config", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}
