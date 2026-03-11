import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { adminLogin } from "../../api/admin";

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await adminLogin({ username, password });
      await queryClient.invalidateQueries({ queryKey: ["admin", "me"] });
      navigate("/admin", { replace: true });
    } catch {
      setError("Invalid username or password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="admin-login-header">
          <img src="/logo.png" alt="AGM Vote" className="admin-login-logo" />
          <h1 className="admin-login-title">Admin Portal</h1>
        </div>
        <form onSubmit={(e) => { void handleSubmit(e); }} className="admin-login-form">
          {error && (
            <p className="admin-login-error" role="alert">
              {error}
            </p>
          )}
          <div className="admin-login-field">
            <label htmlFor="username" className="admin-login-label">
              Username
            </label>
            <input
              id="username"
              type="text"
              className="admin-login-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="admin-login-field">
            <label htmlFor="password" className="admin-login-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="admin-login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn--primary admin-login-submit"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
