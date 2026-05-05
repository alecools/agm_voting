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
  sms_smtp2go_api_key_is_set: boolean;
  sms_from_number: string | null;
  // twilio
  sms_twilio_account_sid: string | null;
  sms_twilio_auth_token_is_set: boolean;
  sms_twilio_from_number: string | null;
  // clicksend
  sms_clicksend_username: string | null;
  sms_clicksend_api_key_is_set: boolean;
  sms_clicksend_from_number: string | null;
  // webhook
  sms_webhook_url: string | null;
  sms_webhook_secret_is_set: boolean;
}

export interface SmsConfigUpdate {
  sms_enabled?: boolean;
  sms_provider?: SmsProvider | null;
  // smtp2go
  sms_smtp2go_api_key?: string | null;
  sms_from_number?: string | null;
  // twilio
  sms_twilio_account_sid?: string | null;
  sms_twilio_auth_token?: string | null;
  sms_twilio_from_number?: string | null;
  // clicksend
  sms_clicksend_username?: string | null;
  sms_clicksend_api_key?: string | null;
  sms_clicksend_from_number?: string | null;
  // webhook
  sms_webhook_url?: string | null;
  sms_webhook_secret?: string | null;
}

export interface SmsTestRequest {
  to: string;
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
  return apiFetch<{ ok: boolean }>("/api/admin/config/sms/test", {
    method: "POST",
    body: JSON.stringify({ to: toPhone } satisfies SmsTestRequest),
  });
}
