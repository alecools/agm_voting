import { apiFetch } from "./client";

export interface TenantConfig {
  app_name: string;
  logo_url: string;
  favicon_url: string | null;
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

export async function uploadLogo(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<{ url: string }>("/api/admin/config/logo", {
    method: "POST",
    body: formData,
  });
}

export async function uploadFavicon(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<{ url: string }>("/api/admin/config/favicon", {
    method: "POST",
    body: formData,
  });
}

export interface SmtpConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_from_email: string;
  password_is_set: boolean;
}

export interface SmtpConfigUpdate {
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_from_email: string;
  smtp_password?: string;
}

export interface SmtpStatus {
  configured: boolean;
}

export async function getSmtpConfig(): Promise<SmtpConfig> {
  return apiFetch<SmtpConfig>("/api/admin/config/smtp");
}

export async function updateSmtpConfig(data: SmtpConfigUpdate): Promise<SmtpConfig> {
  return apiFetch<SmtpConfig>("/api/admin/config/smtp", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function testSmtpConfig(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/admin/config/smtp/test", {
    method: "POST",
  });
}

export async function getSmtpStatus(): Promise<SmtpStatus> {
  return apiFetch<SmtpStatus>("/api/admin/config/smtp/status");
}
