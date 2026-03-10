import React from "react";
import { useNavigate } from "react-router-dom";
import type { Building } from "../../types";

interface BuildingTableProps {
  buildings: Building[];
}

export default function BuildingTable({ buildings }: BuildingTableProps) {
  const navigate = useNavigate();

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={thStyle}>Name</th>
          <th style={thStyle}>Manager Email</th>
          <th style={thStyle}>Created At</th>
        </tr>
      </thead>
      <tbody>
        {buildings.map((b) => (
          <tr key={b.id} style={{ cursor: "pointer" }}>
            <td style={tdStyle}>
              <button
                style={linkButtonStyle}
                onClick={() => navigate(`/admin/buildings/${b.id}`)}
              >
                {b.name}
              </button>
            </td>
            <td style={tdStyle}>{b.manager_email}</td>
            <td style={tdStyle}>{new Date(b.created_at).toLocaleString()}</td>
          </tr>
        ))}
        {buildings.length === 0 && (
          <tr>
            <td colSpan={3} style={{ ...tdStyle, textAlign: "center", color: "#666" }}>
              No buildings found.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  borderBottom: "2px solid #dee2e6",
  background: "#f8f9fa",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #dee2e6",
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#0066cc",
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  font: "inherit",
};
