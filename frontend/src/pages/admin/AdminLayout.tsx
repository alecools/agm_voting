import React from "react";
import { NavLink, Outlet } from "react-router-dom";

export default function AdminLayout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: 200,
          background: "#343a40",
          color: "#fff",
          padding: 16,
          flexShrink: 0,
        }}
      >
        <h2 style={{ margin: "0 0 24px", fontSize: "1.1em", color: "#adb5bd" }}>
          Admin Portal
        </h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <li style={{ marginBottom: 8 }}>
            <NavLink
              to="/admin/buildings"
              style={({ isActive }) => navLinkStyle(isActive)}
            >
              Buildings
            </NavLink>
          </li>
          <li>
            <NavLink
              to="/admin/agms"
              style={({ isActive }) => navLinkStyle(isActive)}
            >
              AGMs
            </NavLink>
          </li>
        </ul>
      </nav>
      <main style={{ flex: 1, padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}

function navLinkStyle(isActive: boolean): React.CSSProperties {
  return {
    color: isActive ? "#fff" : "#adb5bd",
    textDecoration: "none",
    fontWeight: isActive ? 600 : 400,
  };
}
