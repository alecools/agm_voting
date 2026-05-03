import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAdminConfig, updateAdminConfig, uploadLogo, uploadFavicon, getSmtpConfig, updateSmtpConfig, testSmtpConfig } from "../../api/config";
import type { TenantConfig } from "../../api/config";
import { listAdminUsers, inviteAdminUser, removeAdminUser } from "../../api/users";
import type { AdminUser } from "../../api/users";
import { authClient, changePassword } from "../../lib/auth-client";
import PasswordRequirements, { checkPasswordRequirements, allRequirementsMet } from "../../components/PasswordRequirements";
import { getSubscription } from "../../api/subscription";
import type { SubscriptionResponse } from "../../api/subscription";

type SettingsTab = "ui-theme" | "email-server" | "user-management" | "subscription";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("ui-theme");

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
  const [uploadLogoSuccess, setUploadLogoSuccess] = useState(false);
  const [isUploadingFavicon, setIsUploadingFavicon] = useState(false);
  const [uploadFaviconError, setUploadFaviconError] = useState("");
  const [uploadFaviconSuccess, setUploadFaviconSuccess] = useState(false);

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
  const [showTestEmailModal, setShowTestEmailModal] = useState(false);
  const [testEmailRecipient, setTestEmailRecipient] = useState("");

  // User management state
  const hasFetchedUsers = useRef(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [removeConfirmUser, setRemoveConfirmUser] = useState<AdminUser | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeSuccess, setRemoveSuccess] = useState("");
  const [removeError, setRemoveError] = useState("");

  // Subscription tab state
  const hasFetchedSubscription = useRef(false);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState("");

  // Change password state
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [changePwdCurrent, setChangePwdCurrent] = useState("");
  const [changePwdNew, setChangePwdNew] = useState("");
  const [changePwdConfirm, setChangePwdConfirm] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [changePwdError, setChangePwdError] = useState("");
  const [changePwdSuccess, setChangePwdSuccess] = useState("");

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

  function refreshUsers() {
    hasFetchedUsers.current = false;
    setUsersLoading(true);
    setUsersError("");
    Promise.all([
      listAdminUsers(),
      authClient.getSession(),
    ])
      .then(([data, session]) => {
        setUsers(data.users);
        const userId = (session as { data?: { user?: { id?: string } } } | null)?.data?.user?.id ?? null;
        setCurrentUserId(userId);
        hasFetchedUsers.current = true;
      })
      .catch(() => {
        setUsersError("Failed to load users.");
      })
      .finally(() => {
        setUsersLoading(false);
      });
  }

  // Load users when User Management tab is first activated — but only once.
  // Subsequent tab switches reuse the already-fetched list. Mutations call
  // refreshUsers() explicitly to re-fetch after a change.
  useEffect(() => {
    if (activeTab !== "user-management") return;
    if (hasFetchedUsers.current) return;
    refreshUsers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Load subscription when Subscription tab is first activated — once only.
  useEffect(() => {
    if (activeTab !== "subscription") return;
    if (hasFetchedSubscription.current) return;
    setSubscriptionLoading(true);
    setSubscriptionError("");
    getSubscription()
      .then((data) => {
        setSubscription(data);
        hasFetchedSubscription.current = true;
      })
      .catch(() => {
        setSubscriptionError("Failed to load subscription.");
      })
      .finally(() => {
        setSubscriptionLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function handleLogoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploadLogoSuccess(false);
    setIsUploading(true);
    try {
      const result = await uploadLogo(file);
      setLogoUrl(result.url);
      setUploadLogoSuccess(true);
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
    setUploadFaviconSuccess(false);
    setIsUploadingFavicon(true);
    try {
      const result = await uploadFavicon(file);
      setFaviconUrl(result.url);
      setUploadFaviconSuccess(true);
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
    setShowTestEmailModal(false);
    setSmtpTestResult(null);
    setIsTestingSmtp(true);
    try {
      await testSmtpConfig(testEmailRecipient);
      setSmtpTestResult({ ok: true, message: `Test email sent to ${testEmailRecipient}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test email failed.";
      setSmtpTestResult({ ok: false, message });
    } finally {
      setIsTestingSmtp(false);
      setTestEmailRecipient("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveError("");
    setSaveSuccess(false);
    setIsSaving(true);
    // Clear upload success prompts when the user saves
    setUploadLogoSuccess(false);
    setUploadFaviconSuccess(false);
    try {
      const updated: TenantConfig = {
        app_name: appName,
        logo_url: logoUrl,
        favicon_url: faviconUrl,
        primary_colour: primaryColour,
        support_email: supportEmail,
      };
      await updateAdminConfig(updated);
      // Show success immediately — don't block on cache refresh.
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      // Update the cache immediately so branding re-renders without a page refresh,
      // then trigger a background re-fetch to confirm server state.
      queryClient.setQueryData(["public-config"], updated);
      void queryClient.invalidateQueries({ queryKey: ["public-config"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save settings.";
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  }

  function handleInviteModalOpen() {
    setInviteEmail("");
    setInviteError("");
    setInviteSuccess("");
    setShowInviteModal(true);
  }

  function handleInviteModalClose() {
    setShowInviteModal(false);
    setInviteEmail("");
    setInviteError("");
  }

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInviteError("");
    setIsInviting(true);
    try {
      const newUser = await inviteAdminUser(inviteEmail);
      setUsers((prev) => [...prev, newUser]);
      setInviteSuccess(`Invite sent to ${inviteEmail}`);
      setShowInviteModal(false);
      setInviteEmail("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send invite.";
      if (message.includes("409") || message.includes("already exists")) {
        setInviteError("A user with that email already exists.");
      } else {
        setInviteError(message);
      }
    } finally {
      setIsInviting(false);
    }
  }

  async function handleRemoveConfirm() {
    // removeConfirmUser is always set before this function is called — the
    // button that triggers it is only rendered inside `{removeConfirmUser && …}`.
    const userToRemove = removeConfirmUser!;
    setRemoveError("");
    setRemoveSuccess("");
    setIsRemoving(true);
    setRemoveConfirmUser(null);
    try {
      await removeAdminUser(userToRemove.id);
      setUsers((prev) => prev.filter((u) => u.id !== userToRemove.id));
      setRemoveSuccess("User removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove user.";
      if (message.includes("409") || message.includes("last admin")) {
        setRemoveError("Cannot remove the last admin user.");
      } else if (message.includes("403") || message.includes("yourself")) {
        setRemoveError("Cannot remove yourself.");
      } else {
        setRemoveError(message);
      }
    } finally {
      setIsRemoving(false);
    }
  }

  function handleChangePasswordOpen() {
    setChangePwdCurrent("");
    setChangePwdNew("");
    setChangePwdConfirm("");
    setChangePwdError("");
    setChangePwdSuccess("");
    setShowChangePasswordModal(true);
  }

  function handleChangePasswordClose() {
    setShowChangePasswordModal(false);
    setChangePwdCurrent("");
    setChangePwdNew("");
    setChangePwdConfirm("");
    setChangePwdError("");
  }

  async function handleChangePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChangePwdError("");
    setIsChangingPassword(true);
    try {
      const result = await changePassword({
        currentPassword: changePwdCurrent,
        newPassword: changePwdNew,
        revokeOtherSessions: false,
      });
      if (result.error) {
        setChangePwdError(result.error.message ?? "Failed to change password.");
      } else {
        setChangePwdSuccess("Password updated successfully.");
        setShowChangePasswordModal(false);
      }
    } catch {
      setChangePwdError("Failed to change password. Please try again.");
    } finally {
      setIsChangingPassword(false);
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

      {/* Tab navigation */}
      <div
        role="tablist"
        aria-label="Settings sections"
        style={{ display: "flex", gap: 0, borderBottom: "2px solid var(--border)", marginBottom: 24 }}
      >
        <button
          role="tab"
          aria-selected={activeTab === "ui-theme"}
          aria-controls="tab-panel-ui-theme"
          id="tab-ui-theme"
          type="button"
          onClick={() => setActiveTab("ui-theme")}
          style={{
            padding: "10px 20px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "ui-theme" ? "3px solid var(--navy)" : "3px solid transparent",
            fontWeight: activeTab === "ui-theme" ? 700 : 400,
            color: activeTab === "ui-theme" ? "var(--navy)" : "var(--text-secondary)",
            cursor: "pointer",
            marginBottom: -2,
            fontSize: "0.9rem",
          }}
        >
          UI &amp; Theme
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "email-server"}
          aria-controls="tab-panel-email-server"
          id="tab-email-server"
          type="button"
          onClick={() => setActiveTab("email-server")}
          style={{
            padding: "10px 20px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "email-server" ? "3px solid var(--navy)" : "3px solid transparent",
            fontWeight: activeTab === "email-server" ? 700 : 400,
            color: activeTab === "email-server" ? "var(--navy)" : "var(--text-secondary)",
            cursor: "pointer",
            marginBottom: -2,
            fontSize: "0.9rem",
          }}
        >
          Email Server
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "user-management"}
          aria-controls="tab-panel-user-management"
          id="tab-user-management"
          type="button"
          onClick={() => setActiveTab("user-management")}
          style={{
            padding: "10px 20px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "user-management" ? "3px solid var(--navy)" : "3px solid transparent",
            fontWeight: activeTab === "user-management" ? 700 : 400,
            color: activeTab === "user-management" ? "var(--navy)" : "var(--text-secondary)",
            cursor: "pointer",
            marginBottom: -2,
            fontSize: "0.9rem",
          }}
        >
          User Management
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "subscription"}
          aria-controls="tab-panel-subscription"
          id="tab-subscription"
          type="button"
          onClick={() => setActiveTab("subscription")}
          style={{
            padding: "10px 20px",
            background: "none",
            border: "none",
            borderBottom: activeTab === "subscription" ? "3px solid var(--navy)" : "3px solid transparent",
            fontWeight: activeTab === "subscription" ? 700 : 400,
            color: activeTab === "subscription" ? "var(--navy)" : "var(--text-secondary)",
            cursor: "pointer",
            marginBottom: -2,
            fontSize: "0.9rem",
          }}
        >
          Subscription
        </button>
      </div>

      {/* UI & Theme tab */}
      <div
        role="tabpanel"
        id="tab-panel-ui-theme"
        aria-labelledby="tab-ui-theme"
        hidden={activeTab !== "ui-theme"}
      >
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
                  {uploadLogoSuccess && (
                    <p role="status" style={{ color: "var(--green)", fontSize: "0.875rem", marginTop: 4 }}>
                      Logo uploaded successfully
                    </p>
                  )}
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
                  {uploadFaviconSuccess && (
                    <p role="status" style={{ color: "var(--green)", fontSize: "0.875rem", marginTop: 4 }}>
                      Favicon uploaded successfully
                    </p>
                  )}
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
                  <p className="state-message state-message--success" role="status">Settings saved.</p>
                )}
                {saveError && (
                  <p className="field__error">{saveError}</p>
                )}
                {(uploadLogoSuccess || uploadFaviconSuccess) && (
                  <p
                    role="status"
                    style={{
                      color: "var(--amber)",
                      background: "var(--amber-bg)",
                      border: "1px solid #F6C190",
                      borderRadius: "var(--r-md)",
                      padding: "8px 12px",
                      fontSize: "0.875rem",
                      marginBottom: 12,
                    }}
                  >
                    Save settings to apply the changes
                  </p>
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
        </div>

      {/* Email Server tab */}
      <div
        role="tabpanel"
        id="tab-panel-email-server"
        aria-labelledby="tab-email-server"
        hidden={activeTab !== "email-server"}
      >
          <div className="admin-card">
            <div className="admin-card__header">
              <p className="admin-card__title">Mail Server</p>
            </div>
            <div className="admin-card__body">
              {isSmtpUnconfigured && (
                <div className="warning-banner" role="alert">
                  ⚠️ Mail server is not configured — emails will not be sent until SMTP settings are saved.
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
                  <p className="state-message state-message--success" role="status">SMTP settings saved.</p>
                )}
                {smtpSaveError && (
                  <p className="field__error">{smtpSaveError}</p>
                )}

                {smtpTestResult && (
                  <p
                    className={smtpTestResult.ok ? "state-message state-message--success" : "state-message state-message--error"}
                    role="status"
                  >
                    {smtpTestResult.message}
                  </p>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    data-testid="smtp-save-btn"
                    disabled={isSmtpSaving}
                  >
                    {isSmtpSaving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={isTestingSmtp || isSmtpUnconfigured}
                    onClick={() => { setSmtpTestResult(null); setShowTestEmailModal(true); }}
                  >
                    {isTestingSmtp ? "Sending…" : "Send test email"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

      {/* User Management tab */}
      <div
        role="tabpanel"
        id="tab-panel-user-management"
        aria-labelledby="tab-user-management"
        hidden={activeTab !== "user-management"}
      >
          <div className="admin-card">
            <div className="admin-card__header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p className="admin-card__title">Admin Users</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleInviteModalOpen}
                >
                  Invite Admin
                </button>
              </div>
            </div>
            <div className="admin-card__body">

              {inviteSuccess && (
                <p role="status" className="state-message state-message--success">{inviteSuccess}</p>
              )}

              {removeSuccess && (
                <p role="status" className="state-message state-message--success">{removeSuccess}</p>
              )}

              {changePwdSuccess && (
                <p role="status" className="state-message state-message--success">{changePwdSuccess}</p>
              )}

              {removeError && (
                <p className="state-message state-message--error">{removeError}</p>
              )}

              {usersLoading && (
                <p className="state-message">Loading users…</p>
              )}

              {usersError && !usersLoading && (
                <p className="state-message state-message--error">Failed to load users.</p>
              )}

              {!usersLoading && !usersError && users.length === 0 && (
                <p className="state-message">No admin users found.</p>
              )}

              {!usersLoading && !usersError && users.length > 0 && (
                <div className="admin-table-wrapper">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th scope="col">Email</th>
                        <th scope="col">Created</th>
                        <th scope="col"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id}>
                          <td>
                            {user.email}
                            {user.id === currentUserId && (
                              <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: "0.85em" }}>(you)</span>
                            )}
                          </td>
                          <td>
                            {new Date(user.created_at).toLocaleDateString("en-AU")}
                          </td>
                          <td>
                            {user.id === currentUserId ? (
                              <button
                                type="button"
                                className="btn btn--admin"
                                onClick={handleChangePasswordOpen}
                              >
                                Change Password
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn--danger"
                                onClick={() => { setRemoveConfirmUser(user); setRemoveError(""); setRemoveSuccess(""); }}
                                disabled={isRemoving}
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

      {/* Subscription tab */}
      <div
        role="tabpanel"
        id="tab-panel-subscription"
        aria-labelledby="tab-subscription"
        hidden={activeTab !== "subscription"}
      >
        <div className="admin-card">
          <div className="admin-card__header">
            <p className="admin-card__title">Subscription</p>
          </div>
          <div className="admin-card__body">
            {subscriptionLoading && (
              <p className="state-message">Loading subscription…</p>
            )}
            {subscriptionError && !subscriptionLoading && (
              <p className="state-message state-message--error">{subscriptionError}</p>
            )}
            {!subscriptionLoading && !subscriptionError && subscription && (
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 24px" }}>
                <dt className="field__label" style={{ margin: 0 }}>Tier</dt>
                <dd style={{ margin: 0 }}>{subscription.tier_name ?? "No plan set"}</dd>
                <dt className="field__label" style={{ margin: 0 }}>Usage</dt>
                <dd style={{ margin: 0 }}>
                  {subscription.active_building_count}
                  {" / "}
                  {subscription.building_limit !== null ? subscription.building_limit : "Unlimited"}
                  {" buildings"}
                </dd>
              </dl>
            )}
            {!subscriptionLoading && !subscriptionError && subscription && (
              <p style={{ marginTop: 16, color: "var(--text-secondary)", fontSize: "0.875rem" }}>
                To upgrade your plan or request changes, contact support.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Test email modal */}
      {showTestEmailModal && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="test-email-modal-title"
          onKeyDown={(e) => { if (e.key === "Escape") setShowTestEmailModal(false); }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowTestEmailModal(false); }}
        >
          <div className="dialog">
            <h2 id="test-email-modal-title" className="dialog__title">Send test email</h2>
            <div className="dialog__body">
              <div className="field">
                <label className="field__label" htmlFor="test-email-recipient">Recipient email</label>
                <input
                  id="test-email-recipient"
                  className="field__input"
                  type="email"
                  value={testEmailRecipient}
                  onChange={(e) => setTestEmailRecipient(e.target.value)}
                  placeholder="you@example.com"
                  autoFocus
                />
              </div>
            </div>
            <div className="dialog__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setShowTestEmailModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!testEmailRecipient || isTestingSmtp}
                onClick={() => { void handleSmtpTest(); }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invite Admin modal */}
      {showInviteModal && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-admin-modal-title"
          onKeyDown={(e) => { if (e.key === "Escape") handleInviteModalClose(); }}
          onClick={(e) => { if (e.target === e.currentTarget) handleInviteModalClose(); }}
        >
          <div className="dialog">
            <h2 id="invite-admin-modal-title" className="dialog__title">Invite Admin User</h2>
            <form onSubmit={(e) => { void handleInviteSubmit(e); }}>
              <div className="dialog__body">
                <div className="field">
                  <label className="field__label" htmlFor="invite-email">Email address</label>
                  <input
                    id="invite-email"
                    className="field__input"
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="newadmin@example.com"
                    required
                    autoFocus
                    aria-invalid={!!inviteError}
                  />
                  {inviteError && (
                    <span className="field__error">{inviteError}</span>
                  )}
                </div>
              </div>
              <div className="dialog__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleInviteModalClose}
                  disabled={isInviting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={isInviting}
                >
                  {isInviting ? "Sending…" : "Send Invite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Change Password modal */}
      {showChangePasswordModal && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="change-password-modal-title"
          onKeyDown={(e) => { if (e.key === "Escape") handleChangePasswordClose(); }}
          onClick={(e) => { if (e.target === e.currentTarget) handleChangePasswordClose(); }}
        >
          <div className="dialog">
            <h2 id="change-password-modal-title" className="dialog__title">Change Password</h2>
            <form onSubmit={(e) => { void handleChangePasswordSubmit(e); }}>
              <div className="dialog__body">
                {changePwdError && (
                  <p className="field__error" role="alert" style={{ marginBottom: 12 }}>{changePwdError}</p>
                )}
                <div className="field">
                  <label className="field__label" htmlFor="change-pwd-current">Current password</label>
                  <input
                    id="change-pwd-current"
                    className="field__input"
                    type="password"
                    value={changePwdCurrent}
                    onChange={(e) => setChangePwdCurrent(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                    required
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="change-pwd-new">New password</label>
                  <input
                    id="change-pwd-new"
                    className="field__input"
                    type="password"
                    value={changePwdNew}
                    onChange={(e) => setChangePwdNew(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <PasswordRequirements reqs={checkPasswordRequirements(changePwdNew)} />
                <div className="field">
                  <label className="field__label" htmlFor="change-pwd-confirm">Confirm new password</label>
                  <input
                    id="change-pwd-confirm"
                    className="field__input"
                    type="password"
                    value={changePwdConfirm}
                    onChange={(e) => setChangePwdConfirm(e.target.value)}
                    autoComplete="new-password"
                    aria-invalid={changePwdConfirm.length > 0 && changePwdConfirm !== changePwdNew}
                    required
                  />
                  {changePwdConfirm.length > 0 && changePwdConfirm !== changePwdNew && (
                    <span className="field__error">Passwords do not match.</span>
                  )}
                </div>
              </div>
              <div className="dialog__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleChangePasswordClose}
                  disabled={isChangingPassword}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={
                    isChangingPassword ||
                    !allRequirementsMet(checkPasswordRequirements(changePwdNew)) ||
                    changePwdConfirm !== changePwdNew ||
                    !changePwdCurrent
                  }
                >
                  {isChangingPassword ? "Updating…" : "Update Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove user confirmation modal */}
      {removeConfirmUser && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-user-dialog-title"
          onKeyDown={(e) => { if (e.key === "Escape") setRemoveConfirmUser(null); }}
          onClick={() => setRemoveConfirmUser(null)}
        >
          <div
            className="dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="remove-user-dialog-title" className="dialog__title">Remove user?</h2>
            <div className="dialog__body">
              <p>
                Remove <strong>{removeConfirmUser.email}</strong>? They will lose admin access immediately.
              </p>
            </div>
            <div className="dialog__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setRemoveConfirmUser(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={isRemoving}
                onClick={() => { void handleRemoveConfirm(); }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

