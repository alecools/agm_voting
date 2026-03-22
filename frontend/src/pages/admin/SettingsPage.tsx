import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAdminConfig, updateAdminConfig } from "../../api/config";
import type { TenantConfig } from "../../api/config";

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const [appName, setAppName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColour, setPrimaryColour] = useState("#005f73");
  const [supportEmail, setSupportEmail] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    getAdminConfig()
      .then((data: TenantConfig) => {
        setAppName(data.app_name);
        setLogoUrl(data.logo_url);
        setPrimaryColour(data.primary_colour);
        setSupportEmail(data.support_email);
      })
      .catch(() => {
        setSaveError("Failed to load settings.");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveError("");
    setSaveSuccess(false);
    setIsSaving(true);
    try {
      await updateAdminConfig({
        app_name: appName,
        logo_url: logoUrl,
        primary_colour: primaryColour,
        support_email: supportEmail,
      });
      // Invalidate the public-config query so BrandingProvider re-fetches
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
              <input
                id="logo-url"
                className="field__input"
                type="text"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://example.com/logo.png"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="primary-colour-text">Primary colour</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  id="primary-colour-picker"
                  type="color"
                  value={primaryColour}
                  onChange={(e) => setPrimaryColour(e.target.value)}
                  aria-label="Primary colour picker"
                  style={{ width: 40, height: 36, padding: 2, border: "1px solid var(--border)", borderRadius: "var(--r-md)", cursor: "pointer" }}
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
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
