import { NavLink, Outlet, Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { adminLogout } from "../../api/admin";

export default function AdminLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
          <img src="/logo.png" alt="General Meeting Vote" className="admin-sidebar__logo" />
          <span className="admin-sidebar__role">Admin Portal</span>
        </div>
        <ul className="admin-nav">
          <li className="admin-nav__item">
            <NavLink
              to="/admin/buildings"
              className={({ isActive }) =>
                `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
              }
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
            >
              General Meetings
            </NavLink>
          </li>
        </ul>
        <div style={{ marginTop: "auto", padding: "12px", borderTop: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 8 }}>
          <Link to="/" className="admin-nav__link" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            ← Voter portal
          </Link>
          <button
            className="admin-nav__link"
            style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "inherit" }}
            onClick={() => { void handleLogout(); }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
