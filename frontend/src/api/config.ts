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

export async function testSmtpConfig(toEmail: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/admin/config/smtp/test", {
    method: "POST",
    body: JSON.stringify({ to_email: toEmail }),
  });
}

export async function getSmtpStatus(): Promise<SmtpStatus> {
  return apiFetch<SmtpStatus>("/api/admin/config/smtp/status");
}

export type SmsProvider = "smtp2go" | "twilio" | "clicksend" | "webhook";

export interface SmsConfigOut {
  sms_enabled: boolean;
  sms_provider: SmsProvider | null;
  // smtp2go
  smtp2go_api_key_is_set: boolean;
  smtp2go_sender_number: string;
  // twilio
  twilio_account_sid: string;
  twilio_auth_token_is_set: boolean;
  twilio_from_number: string;
  // clicksend
  clicksend_username: string;
  clicksend_api_key_is_set: boolean;
  clicksend_from_number: string;
  // webhook
  webhook_url: string;
  webhook_secret_is_set: boolean;
}

export interface SmsConfigUpdate {
  sms_enabled?: boolean;
  sms_provider?: SmsProvider | null;
  // smtp2go
  smtp2go_api_key?: string | null;
  smtp2go_sender_number?: string | null;
  // twilio
  twilio_account_sid?: string | null;
  twilio_auth_token?: string | null;
  twilio_from_number?: string | null;
  // clicksend
  clicksend_username?: string | null;
  clicksend_api_key?: string | null;
  clicksend_from_number?: string | null;
  // webhook
  webhook_url?: string | null;
  webhook_secret?: string | null;
}

export interface SmsTestRequest {
  to_phone: string;
}

export async function getSmsConfig(): Promise<SmsConfigOut> {
  return apiFetch<SmsConfigOut>("/api/admin/config/sms");
}

export async function updateSmsConfig(data: SmsConfigUpdate): Promise<SmsConfigOut> {
  return apiFetch<SmsConfigOut>("/api/admin/config/sms", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function testSmsConfig(toPhone: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/admin/settings/sms/test", {
    method: "POST",
    body: JSON.stringify({ to_phone: toPhone } satisfies SmsTestRequest),
  });
}
