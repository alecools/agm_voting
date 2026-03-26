import { useState } from "react";
import { NavLink, Outlet, Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { adminLogout } from "../../api/admin";
import { useBranding } from "../../context/BrandingContext";

function NavContent({ onNavClick }: { onNavClick?: () => void }) {
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
  const { config } = useBranding();

  async function handleLogout() {
    try {
      await adminLogout();
    } finally {
      queryClient.clear();
      navigate("/admin/login", { replace: true });
    }
  }

  return (
    <div className="admin-layout">
      <nav className="admin-sidebar">
        <div className="admin-sidebar__header">
          {config.logo_url ? (
            <img src={config.logo_url} alt={config.app_name} className="admin-sidebar__logo" />
          ) : (
            <span className="admin-sidebar__app-name">{config.app_name}</span>
          )}
          <span className="admin-sidebar__role">Admin Portal</span>
        </div>
        <NavContent />
        <div style={{ padding: "12px", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="admin-nav__link"
            style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "inherit" }}
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
          {config.logo_url ? (
            <img src={config.logo_url} alt={config.app_name} className="admin-sidebar__logo" />
          ) : (
            <span className="admin-sidebar__app-name">{config.app_name}</span>
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
        <NavContent onNavClick={() => setIsNavOpen(false)} />
        <div style={{ padding: "12px", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="admin-nav__link"
            style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "inherit" }}
            onClick={() => { void handleLogout(); }}
          >
            Sign out
          </button>
        </div>
      </div>

      <main className="admin-main">
        <button
          className="admin-nav-open-btn"
          onClick={() => setIsNavOpen(true)}
          aria-label="Open navigation"
          aria-expanded={isNavOpen}
        >
          ☰ Menu
        </button>
        <Outlet />
      </main>
    </div>
  );
}
