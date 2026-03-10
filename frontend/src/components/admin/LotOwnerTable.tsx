import React from "react";
import type { LotOwner } from "../../types";

interface LotOwnerTableProps {
  lotOwners: LotOwner[];
  onEdit: (lotOwner: LotOwner) => void;
}

export default function LotOwnerTable({ lotOwners, onEdit }: LotOwnerTableProps) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={thStyle}>Lot Number</th>
          <th style={thStyle}>Email</th>
          <th style={thStyle}>Unit Entitlement</th>
          <th style={thStyle}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {lotOwners.map((lo) => (
          <tr key={lo.id}>
            <td style={tdStyle}>{lo.lot_number}</td>
            <td style={tdStyle}>{lo.email}</td>
            <td style={tdStyle}>{lo.unit_entitlement}</td>
            <td style={tdStyle}>
              <button onClick={() => onEdit(lo)}>Edit</button>
            </td>
          </tr>
        ))}
        {lotOwners.length === 0 && (
          <tr>
            <td colSpan={4} style={{ ...tdStyle, textAlign: "center", color: "#666" }}>
              No lot owners found.
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
