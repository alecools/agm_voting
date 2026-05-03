import { useState, useEffect, useRef } from "react";
import { NavLink, Outlet, Link, useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../lib/auth-client";
import { useBranding } from "../../context/BrandingContext";
import { getSmtpStatus } from "../../api/config";

function NavContent({ onNavClick, isServerAdmin }: { onNavClick?: () => void; isServerAdmin?: boolean }) {
  return (
    <>
      <ul className="admin-nav">
        <li className="admin-nav__item">
          <NavLink
            to="/admin/buildings"
            className={({ isActive }) =>
              `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
            }
            onClick={onNavClick}
          >
            Buildings
          </NavLink>
        </li>
        <li className="admin-nav__item">
          <NavLink
            to="/admin/general-meetings"
            className={({ isActive }) =>
              `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
            }
            onClick={onNavClick}
          >
            General Meetings
          </NavLink>
        </li>
        <li className="admin-nav__item">
          <NavLink
            to="/admin/settings"
            className={({ isActive }) =>
              `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
            }
            onClick={onNavClick}
          >
            Settings
          </NavLink>
        </li>
        {isServerAdmin && (
          <li className="admin-nav__item">
            <NavLink
              to="/admin/control-room"
              className={({ isActive }) =>
                `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
              }
              onClick={onNavClick}
            >
              Control Room
            </NavLink>
          </li>
        )}
      </ul>
      <div style={{ marginTop: "auto", padding: "12px", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 8 }}>
        <Link to="/" className="admin-nav__link" style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={onNavClick}>
          ← Voter portal
        </Link>
      </div>
    </>
  );
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isNavOpen, setIsNavOpen] = useState(false);
  const { config, effectiveLogoUrl } = useBranding();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  const [smtpBannerDismissed, setSmtpBannerDismissed] = useState(false);
  const { data: sessionData } = authClient.useSession();
  const isServerAdmin = (sessionData as { user?: { role?: string } } | null)?.user?.role === "admin";

  useEffect(() => {
    setSmtpBannerDismissed(false);
    getSmtpStatus()
      .then((status) => setSmtpConfigured(status.configured))
      .catch(() => setSmtpConfigured(null));
  }, [location.pathname]);

  // US-ACC-06: Close mobile nav drawer on Escape key press and return focus to menu button
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isNavOpen) {
        setIsNavOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isNavOpen]);

  async function handleLogout() {
    try {
      await authClient.signOut();
    } finally {
      queryClient.clear();
      navigate("/admin/login", { replace: true });
    }
  }

  return (
    <div className="admin-layout">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <nav className="admin-sidebar">
        <div className="admin-sidebar__header">
          {/* Fix 11: always render an img using effectiveLogoUrl (OCSS fallback when no logo configured) */}
          <img src={effectiveLogoUrl} alt={config.app_name} className="admin-sidebar__logo" />
          {!config.logo_url && (
            <span className="admin-sidebar__app-name">{config.app_name || "General Meeting"}</span>
          )}
          <span className="admin-sidebar__role">Admin Portal</span>
        </div>
        <NavContent isServerAdmin={isServerAdmin} />
        <div style={{ padding: "12px", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="admin-nav__link"
            style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "rgba(255,255,255,.85)" }}
            onClick={() => { void handleLogout(); }}
          >
            Sign out
          </button>
        </div>
      </nav>

      {isNavOpen && (
        <div
          className="admin-nav-drawer__backdrop"
          onClick={() => setIsNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={`admin-nav-drawer${isNavOpen ? " admin-nav-drawer--open" : ""}`}
        aria-hidden={!isNavOpen}
        data-testid="admin-nav-drawer"
      >
        <div className="admin-sidebar__header">
          {/* Fix 11: always render an img using effectiveLogoUrl (OCSS fallback when no logo configured) */}
          <img src={effectiveLogoUrl} alt={config.app_name} className="admin-sidebar__logo" />
          {!config.logo_url && (
            <span className="admin-sidebar__app-name">{config.app_name || "General Meeting"}</span>
          )}
          <span className="admin-sidebar__role">Admin Portal</span>
        </div>
        <button
          className="admin-nav-drawer__close"
          onClick={() => setIsNavOpen(false)}
          aria-label="Close navigation"
        >
          ✕
        </button>
        <NavContent onNavClick={() => setIsNavOpen(false)} isServerAdmin={isServerAdmin} />
        <div style={{ padding: "12px", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="admin-nav__link"
            style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "rgba(255,255,255,.85)" }}
            onClick={() => { void handleLogout(); }}
          >
            Sign out
          </button>
        </div>
      </div>

      <main className="admin-main" id="main-content">
        <button
          ref={menuButtonRef}
          className="admin-nav-open-btn"
          onClick={() => setIsNavOpen(true)}
          aria-label="Open navigation"
          aria-expanded={isNavOpen}
        >
          ☰ Menu
        </button>
        {smtpConfigured === false && !smtpBannerDismissed && (
          <div
            className="warning-banner"
            role="alert"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span>
              Mail server not configured — meeting results emails will not be sent.{" "}
              <Link to="/admin/settings" style={{ color: "inherit", fontWeight: 600 }}>Configure now →</Link>
            </span>
            <button
              type="button"
              onClick={() => setSmtpBannerDismissed(true)}
              aria-label="Dismiss SMTP warning"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 4px", fontSize: "1rem" }}
            >
              ✕
            </button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
