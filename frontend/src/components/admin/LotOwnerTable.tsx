import { useState } from "react";
import type { LotOwner } from "../../types";
import Pagination from "./Pagination";

const PAGE_SIZE = 25;

interface LotOwnerTableProps {
  lotOwners: LotOwner[];
  onEdit: (lotOwner: LotOwner) => void;
  isLoading?: boolean;
}

function FinancialPositionBadge({ position }: { position: string }) {
  if (position === "in_arrear") {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: "12px",
          background: "#f59e0b",
          color: "#0C1B2E",
          fontSize: "0.75rem",
          fontWeight: 600,
        }}
      >
        In Arrear
      </span>
    );
  }
  return <span style={{ color: "var(--text-muted, #888)", fontSize: "0.875rem" }}>Normal</span>;
}

export default function LotOwnerTable({ lotOwners, onEdit, isLoading }: LotOwnerTableProps) {
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(lotOwners.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = lotOwners.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const paginationControls = totalPages > 1 ? (
    <Pagination
      page={safePage}
      totalPages={totalPages}
      totalItems={lotOwners.length}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
    />
  ) : null;

  return (
    <div>
      {paginationControls}
      <div className="admin-table-wrapper">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Lot Number</th>
            <th>Email</th>
            <th>Unit Entitlement</th>
            <th>Financial Position</th>
            <th>Proxy</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && !lotOwners.length ? (
            <tr>
              <td colSpan={6} className="state-message">Loading lot owners...</td>
            </tr>
          ) : lotOwners.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px 14px" }}>
                No lot owners found.
              </td>
            </tr>
          ) : (
            visible.map((lo) => (
              <tr key={lo.id}>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                  {lo.lot_number}
                </td>
                <td>{(lo.emails ?? []).join(", ")}</td>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                  {lo.unit_entitlement}
                </td>
                <td>
                  <FinancialPositionBadge position={lo.financial_position} />
                </td>
                <td style={{ fontSize: "0.875rem", color: lo.proxy_email ? "inherit" : "var(--text-muted, #888)" }}>
                  {lo.proxy_email ?? "None"}
                </td>
                <td>
                  <button className="btn btn--secondary" style={{ padding: "5px 14px", fontSize: "0.8rem" }} onClick={() => onEdit(lo)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
      {paginationControls}
    </div>
  );
}
