import React from "react";
import { useNavigate } from "react-router-dom";
import type { AGMListItem } from "../../api/admin";
import StatusBadge from "./StatusBadge";

interface AGMTableProps {
  agms: AGMListItem[];
}

export default function AGMTable({ agms }: AGMTableProps) {
  const navigate = useNavigate();

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={thStyle}>Building</th>
          <th style={thStyle}>Title</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Meeting At</th>
          <th style={thStyle}>Voting Closes At</th>
        </tr>
      </thead>
      <tbody>
        {agms.map((agm) => (
          <tr
            key={agm.id}
            style={{ cursor: "pointer" }}
            onClick={() => navigate(`/admin/agms/${agm.id}`)}
          >
            <td style={tdStyle}>{agm.building_name}</td>
            <td style={tdStyle}>{agm.title}</td>
            <td style={tdStyle}>
              <StatusBadge status={agm.status} />
            </td>
            <td style={tdStyle}>{new Date(agm.meeting_at).toLocaleString()}</td>
            <td style={tdStyle}>{new Date(agm.voting_closes_at).toLocaleString()}</td>
          </tr>
        ))}
        {agms.length === 0 && (
          <tr>
            <td colSpan={5} style={{ ...tdStyle, textAlign: "center", color: "#666" }}>
              No AGMs found.
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
