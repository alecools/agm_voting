import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAdminConfig, updateAdminConfig, uploadLogo, uploadFavicon, getSmtpConfig, updateSmtpConfig, testSmtpConfig } from "../../api/config";
import type { TenantConfig } from "../../api/config";

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const [appName, setAppName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [primaryColour, setPrimaryColour] = useState("#005f73");
  const [supportEmail, setSupportEmail] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [isUploadingFavicon, setIsUploadingFavicon] = useState(false);
  const [uploadFaviconError, setUploadFaviconError] = useState("");

  // SMTP state
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpFromEmail, setSmtpFromEmail] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpPasswordIsSet, setSmtpPasswordIsSet] = useState(false);
  const [isSmtpUnconfigured, setIsSmtpUnconfigured] = useState(false);
  const [isSmtpSaving, setIsSmtpSaving] = useState(false);
  const [smtpSaveSuccess, setSmtpSaveSuccess] = useState(false);
  const [smtpSaveError, setSmtpSaveError] = useState("");
  const [isTestingSmtp, setIsTestingSmtp] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    Promise.all([getAdminConfig(), getSmtpConfig()])
      .then(([config, smtp]) => {
        setAppName(config.app_name);
        setLogoUrl(config.logo_url);
        setFaviconUrl(config.favicon_url);
        setPrimaryColour(config.primary_colour);
        setSupportEmail(config.support_email);

        setSmtpHost(smtp.smtp_host);
        setSmtpPort(smtp.smtp_port);
        setSmtpUsername(smtp.smtp_username);
        setSmtpFromEmail(smtp.smtp_from_email);
        setSmtpPasswordIsSet(smtp.password_is_set);
        const isUnconfigured = !smtp.smtp_host || !smtp.smtp_username || !smtp.smtp_from_email || !smtp.password_is_set;
        setIsSmtpUnconfigured(isUnconfigured);
      })
      .catch(() => {
        setSaveError("Failed to load settings.");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  async function handleLogoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError("");
    setIsUploading(true);
    try {
      const result = await uploadLogo(file);
      setLogoUrl(result.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to upload logo.";
      setUploadError(message);
    } finally {
      setIsUploading(false);
    }
  }

  async function handleFaviconFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFaviconError("");
    setIsUploadingFavicon(true);
    try {
      const result = await uploadFavicon(file);
      setFaviconUrl(result.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to upload favicon.";
      setUploadFaviconError(message);
    } finally {
      setIsUploadingFavicon(false);
    }
  }

  async function handleSmtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSmtpSaveError("");
    setSmtpSaveSuccess(false);
    setSmtpTestResult(null);
    setIsSmtpSaving(true);
    try {
      const payload: Parameters<typeof updateSmtpConfig>[0] = {
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_username: smtpUsername,
        smtp_from_email: smtpFromEmail,
      };
      if (smtpPassword) {
        payload.smtp_password = smtpPassword;
      }
      const updated = await updateSmtpConfig(payload);
      setSmtpPasswordIsSet(updated.password_is_set);
      setSmtpPassword("");
      const isUnconfigured = !updated.smtp_host || !updated.smtp_username || !updated.smtp_from_email || !updated.password_is_set;
      setIsSmtpUnconfigured(isUnconfigured);
      setSmtpSaveSuccess(true);
      setTimeout(() => setSmtpSaveSuccess(false), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save SMTP settings.";
      setSmtpSaveError(message);
    } finally {
      setIsSmtpSaving(false);
    }
  }

  async function handleSmtpTest() {
    setSmtpTestResult(null);
    setIsTestingSmtp(true);
    try {
      await testSmtpConfig();
      setSmtpTestResult({ ok: true, message: `Test email sent to ${smtpFromEmail}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test email failed.";
      setSmtpTestResult({ ok: false, message });
    } finally {
      setIsTestingSmtp(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveError("");
    setSaveSuccess(false);
    setIsSaving(true);
    try {
      const updated: TenantConfig = {
        app_name: appName,
        logo_url: logoUrl,
        favicon_url: faviconUrl,
        primary_colour: primaryColour,
        support_email: supportEmail,
      };
      await updateAdminConfig(updated);
      // Update the cache immediately so branding re-renders without a page refresh,
      // then invalidate to trigger a background re-fetch confirming server state.
      queryClient.setQueryData(["public-config"], updated);
      await queryClient.invalidateQueries({ queryKey: ["public-config"] });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save settings.";
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  }

  // type="color" requires exactly #rrggbb. If the text input holds a partial
  // or invalid hex, fall back to the default so the picker remains functional.
  const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
  const pickerValue = COLOUR_RE.test(primaryColour) ? primaryColour : "#005f73";

  if (isLoading) {
    return <p className="state-message">Loading settings…</p>;
  }

  return (
    <div>
      <div className="admin-page-header">
        <h1>Settings</h1>
      </div>

      <div className="admin-card">
        <div className="admin-card__header">
          <p className="admin-card__title">Tenant Branding</p>
        </div>
        <div className="admin-card__body">
          <form onSubmit={(e) => { void handleSubmit(e); }} className="admin-form">
            <div className="field">
              <label className="field__label" htmlFor="app-name">App name</label>
              <input
                id="app-name"
                className="field__input"
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="logo-url">Logo URL</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  id="logo-url"
                  className="field__input"
                  type="text"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://example.com/logo.png"
                  style={{ flex: 1 }}
                />
                <label htmlFor="logo-file" className="btn btn--secondary" style={{ whiteSpace: "nowrap" }}>
                  {isUploading ? "Uploading…" : "Upload"}
                </label>
                <input
                  id="logo-file"
                  type="file"
                  aria-label="Upload logo image"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={(e) => { void handleLogoFileChange(e); }}
                  disabled={isUploading}
                  data-testid="logo-file-input"
                  style={{ position: "absolute", opacity: 0, width: "1px", height: "1px" }}
                />
              </div>
              {uploadError && <span className="field__error">{uploadError}</span>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="favicon-url">Favicon URL</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  id="favicon-url"
                  className="field__input"
                  type="text"
                  value={faviconUrl ?? ""}
                  onChange={(e) => setFaviconUrl(e.target.value || null)}
                  placeholder="https://example.com/favicon.ico"
                  style={{ flex: 1 }}
                />
                <label htmlFor="favicon-file" className="btn btn--secondary" style={{ whiteSpace: "nowrap" }}>
                  {isUploadingFavicon ? "Uploading…" : "Upload"}
                </label>
                <input
                  id="favicon-file"
                  type="file"
                  aria-label="Upload favicon image"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
                  onChange={(e) => { void handleFaviconFileChange(e); }}
                  disabled={isUploadingFavicon}
                  data-testid="favicon-file-input"
                  style={{ position: "absolute", opacity: 0, width: "1px", height: "1px" }}
                />
              </div>
              {uploadFaviconError && <span className="field__error">{uploadFaviconError}</span>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="primary-colour-text">Primary colour</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="primary-colour-picker"
                  type="color"
                  value={pickerValue}
                  onChange={(e) => setPrimaryColour(e.target.value)}
                  aria-label="Primary colour picker"
                  style={{ width: 40, height: 36, padding: 0, border: "1px solid var(--border)", borderRadius: "var(--r-md)", cursor: "pointer" }}
                />
                <input
                  id="primary-colour-text"
                  className="field__input"
                  type="text"
                  value={primaryColour}
                  onChange={(e) => setPrimaryColour(e.target.value)}
                  placeholder="#005f73"
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="support-email">Support email</label>
              <input
                id="support-email"
                className="field__input"
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="support@example.com"
              />
            </div>

            {saveSuccess && (
              <p style={{ color: "var(--green)", marginBottom: 12 }}>Settings saved.</p>
            )}
            {saveError && (
              <p className="field__error" style={{ marginBottom: 12 }}>{saveError}</p>
            )}

            <button
              type="submit"
              className="btn btn--primary"
              disabled={isSaving}
              data-testid="branding-save-btn"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </form>
        </div>
      </div>

      <div className="admin-card">
        <div className="admin-card__header">
          <p className="admin-card__title">Mail Server</p>
        </div>
        <div className="admin-card__body">
          {isSmtpUnconfigured && (
            <div
              className="notice notice--warning"
              role="alert"
              style={{ marginBottom: 16 }}
            >
              Mail server is not configured — emails will not be sent until SMTP settings are saved.
            </div>
          )}
          <form onSubmit={(e) => { void handleSmtpSubmit(e); }} className="admin-form">
            <div className="field">
              <label className="field__label" htmlFor="smtp-host">Host</label>
              <input
                id="smtp-host"
                className="field__input"
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                required
                placeholder="smtp.example.com"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="smtp-port">Port</label>
              <input
                id="smtp-port"
                className="field__input"
                type="number"
                min={1}
                max={65535}
                value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))}
                required
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="smtp-username">Username</label>
              <input
                id="smtp-username"
                className="field__input"
                type="text"
                value={smtpUsername}
                onChange={(e) => setSmtpUsername(e.target.value)}
                required
                placeholder="user@example.com"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="smtp-from-email">From email address</label>
              <input
                id="smtp-from-email"
                className="field__input"
                type="email"
                value={smtpFromEmail}
                onChange={(e) => setSmtpFromEmail(e.target.value)}
                required
                placeholder="noreply@example.com"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="smtp-password">Password</label>
              <input
                id="smtp-password"
                className="field__input"
                type="password"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
                placeholder={smtpPasswordIsSet ? "Enter new password to change" : "Enter password"}
                autoComplete="new-password"
              />
            </div>

            {smtpSaveSuccess && (
              <p style={{ color: "var(--green)", marginBottom: 12 }}>SMTP settings saved.</p>
            )}
            {smtpSaveError && (
              <p className="field__error" style={{ marginBottom: 12 }}>{smtpSaveError}</p>
            )}

            {smtpTestResult && (
              <p
                style={{
                  color: smtpTestResult.ok ? "var(--green)" : "var(--red)",
                  marginBottom: 12,
                }}
                role="status"
              >
                {smtpTestResult.message}
              </p>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={isSmtpSaving}
              >
                {isSmtpSaving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={isTestingSmtp || isSmtpUnconfigured}
                onClick={() => { void handleSmtpTest(); }}
              >
                {isTestingSmtp ? "Sending…" : "Send test email"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
