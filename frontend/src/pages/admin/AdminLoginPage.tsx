import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../../lib/auth-client";
import { useBranding } from "../../context/BrandingContext";
import PasswordRequirements, { checkPasswordRequirements, allRequirementsMet } from "../../components/PasswordRequirements";

type View = "login" | "reset" | "set-password";

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { config } = useBranding();

  // Login form state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Rate-limit countdown state: timestamp (ms since epoch) when the lockout expires.
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const [countdownMs, setCountdownMs] = useState<number>(0);

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

  // Countdown ticker: updates every second while rate-limited.
  useEffect(() => {
    if (rateLimitedUntil === null) return;
    const tick = () => {
      const remaining = rateLimitedUntil - Date.now();
      if (remaining <= 0) {
        setRateLimitedUntil(null);
        setCountdownMs(0);
      } else {
        setCountdownMs(remaining);
      }
    };
    tick(); // run immediately so the display is correct on first render
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [rateLimitedUntil]);

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
      // Use a direct fetch so we can inspect the HTTP status and extract
      // retry_after_seconds from a 429 response body.  The Better Auth SDK
      // does not expose the raw HTTP status code, making 429 detection unreliable.
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });

      if (res.status === 429) {
        let retryAfterSeconds = 900; // safe default: 15 minutes
        try {
          const body = await res.json() as { detail?: string; retry_after_seconds?: number };
          if (typeof body.retry_after_seconds === "number") {
            retryAfterSeconds = body.retry_after_seconds;
          }
        } catch {
          // ignore JSON parse errors — use default
        }
        setRateLimitedUntil(Date.now() + retryAfterSeconds * 1000);
        return;
      }

      if (!res.ok) {
        setLoginError("Invalid email or password.");
        return;
      }

      // Refetch the session so RequireAdminAuth sees it before we navigate.
      // Without this, useSession() may still return null on the next render,
      // causing a redirect back to the login page.
      await authClient.getSession();
      navigate("/admin", { replace: true });
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

                <PasswordRequirements reqs={checkPasswordRequirements(newPassword)} />

                <button
                  type="submit"
                  className="btn btn--primary btn--full"
                  disabled={setPasswordLoading || !allRequirementsMet(checkPasswordRequirements(newPassword))}
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
            {rateLimitedUntil !== null ? (
              <p className="admin-login-card__error" role="status">
                Too many failed attempts. Try again in {formatCountdown(countdownMs)}
              </p>
            ) : loginError ? (
              <p className="admin-login-card__error" role="alert">
                {loginError}
              </p>
            ) : null}

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
              disabled={loginLoading || rateLimitedUntil !== null}
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
