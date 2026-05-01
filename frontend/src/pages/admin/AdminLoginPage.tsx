import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../../lib/auth-client";
import { useBranding } from "../../context/BrandingContext";

type View = "login" | "reset" | "set-password";

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { config } = useBranding();

  // Login form state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Forgot password state
  const [view, setView] = useState<View>("login");
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Set new password state
  const [newPassword, setNewPassword] = useState("");
  const [setPasswordLoading, setSetPasswordLoading] = useState(false);
  const [setPasswordError, setSetPasswordError] = useState<string | null>(null);
  const [setPasswordSuccess, setSetPasswordSuccess] = useState(false);

  const resetEmailRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);

  // If a reset token is present in the URL, switch to set-password view
  useEffect(() => {
    const token = searchParams.get("token");
    if (token) {
      setView("set-password");
    }
  }, [searchParams]);

  // Move focus to the relevant input when the view changes
  useEffect(() => {
    if (view === "reset") {
      resetEmailRef.current?.focus();
    } else if (view === "set-password") {
      newPasswordRef.current?.focus();
    }
  }, [view]);

  function showResetView() {
    setResetEmail(email);
    setResetError(null);
    setResetSuccess(false);
    setView("reset");
  }

  function showLoginView() {
    setLoginError(null);
    setView("login");
  }

  async function handleSetPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSetPasswordError(null);
    setSetPasswordLoading(true);
    const token = searchParams.get("token") ?? "";
    try {
      const result = await authClient.resetPassword({ newPassword, token });
      if (result.error) {
        setSetPasswordError(result.error.message ?? "Failed to set new password.");
      } else {
        setSetPasswordSuccess(true);
        // Remove the token from the URL so a refresh doesn't re-trigger this view
        setSearchParams({});
      }
    } catch {
      setSetPasswordError("Failed to set new password. Please try again.");
    } finally {
      setSetPasswordLoading(false);
    }
  }

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setLoginError("Invalid email or password.");
      } else {
        navigate("/admin", { replace: true });
      }
    } catch {
      setLoginError("Invalid email or password.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResetError(null);
    setResetSuccess(false);
    setResetLoading(true);
    try {
      const result = await authClient.forgetPassword({
        email: resetEmail,
      });
      if (result.error) {
        setResetError(result.error.message ?? "Failed to send reset link.");
      } else {
        setResetSuccess(true);
      }
    } catch {
      setResetError("Failed to send reset link. Please try again.");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="admin-login-card__header">
          {config.logo_url ? (
            <img src={config.logo_url} alt={config.app_name} className="admin-login-card__logo" />
          ) : (
            <span className="admin-login-card__app-name">{config.app_name}</span>
          )}
          <h1 className="admin-login-card__title">Admin Portal</h1>
          <p className="admin-login-card__subtitle">Sign in to manage buildings and General Meetings</p>
        </div>

        {view === "set-password" ? (
          <form onSubmit={(e) => { void handleSetPasswordSubmit(e); }} className="admin-login-card__form">
            {setPasswordSuccess ? (
              <p className="admin-login-card__success" role="status">
                Password updated. You can now sign in with your new password.
              </p>
            ) : (
              <>
                {setPasswordError && (
                  <p className="admin-login-card__error" role="alert">
                    {setPasswordError}
                  </p>
                )}

                <div className="field">
                  <label htmlFor="new-password" className="field__label">
                    New password
                  </label>
                  <input
                    id="new-password"
                    ref={newPasswordRef}
                    type="password"
                    className="field__input"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--primary btn--full"
                  disabled={setPasswordLoading}
                >
                  {setPasswordLoading ? "Setting password…" : "Set new password"}
                </button>
              </>
            )}

            <button
              type="button"
              className="btn btn--ghost admin-login-back-to-login"
              onClick={showLoginView}
            >
              ← Back to login
            </button>
          </form>
        ) : view === "login" ? (
          <form onSubmit={(e) => { void handleLoginSubmit(e); }} className="admin-login-card__form">
            {loginError && (
              <p className="admin-login-card__error" role="alert">
                {loginError}
              </p>
            )}

            <div className="field">
              <label htmlFor="email" className="field__label">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="field__input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="password" className="field__label">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="field__input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            <button
              type="submit"
              className="btn btn--primary btn--full"
              disabled={loginLoading}
            >
              {loginLoading ? "Signing in…" : "Sign in"}
            </button>

            <button
              type="button"
              className="btn btn--ghost admin-login-forgot"
              onClick={showResetView}
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => { void handleResetSubmit(e); }} className="admin-login-card__form">
            {resetSuccess ? (
              <p className="admin-login-card__success" role="status">
                If that email is registered, a reset link has been sent.
              </p>
            ) : (
              <>
                {resetError && (
                  <p className="admin-login-card__error" role="alert">
                    {resetError}
                  </p>
                )}

                <div className="field">
                  <label htmlFor="reset-email" className="field__label">
                    Email
                  </label>
                  <input
                    id="reset-email"
                    ref={resetEmailRef}
                    type="email"
                    className="field__input"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn--primary btn--full"
                  disabled={resetLoading}
                >
                  {resetLoading ? "Sending…" : "Send reset link"}
                </button>
              </>
            )}

            <button
              type="button"
              className="btn btn--ghost admin-login-back-to-login"
              onClick={showLoginView}
            >
              ← Back to login
            </button>
          </form>
        )}

        <button
          type="button"
          className="btn btn--ghost admin-login-back"
          onClick={() => navigate("/")}
        >
          ← Back to home
        </button>
      </div>
    </div>
  );
}
