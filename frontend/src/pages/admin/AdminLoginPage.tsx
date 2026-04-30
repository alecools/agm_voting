import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../../lib/auth-client";
import { useBranding } from "../../context/BrandingContext";

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const { config } = useBranding();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setError("Invalid email or password.");
      } else {
        navigate("/admin", { replace: true });
      }
    } catch {
      setError("Invalid email or password.");
    } finally {
      setLoading(false);
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

        <form onSubmit={(e) => { void handleSubmit(e); }} className="admin-login-card__form">
          {error && (
            <p className="admin-login-card__error" role="alert">
              {error}
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
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
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
