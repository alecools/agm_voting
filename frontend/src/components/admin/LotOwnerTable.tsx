import type { LotOwner } from "../../types";
import SortableColumnHeader from "./SortableColumnHeader";
import type { SortDir } from "./SortableColumnHeader";

interface LotOwnerTableProps {
  lotOwners: LotOwner[];
  onEdit: (lotOwner: LotOwner) => void;
  isLoading?: boolean;
  sortColumn?: string;
  sortDir?: SortDir;
  onSortChange?: (column: string) => void;
}

function FinancialPositionBadge({ position }: { position: string }) {
  // US-ACC-04: status conveyed by text label AND colour (never colour alone)
  if (position === "in_arrear") {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: "12px",
          background: "var(--amber-bg)",
          color: "var(--amber)",
          fontSize: "0.75rem",
          fontWeight: 600,
          border: "1px solid var(--amber)",
        }}
      >
        In Arrear
      </span>
    );
  }
  return <span style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>Normal</span>;
}

export default function LotOwnerTable({
  lotOwners,
  onEdit,
  isLoading,
  sortColumn = "lot_number",
  sortDir = "asc",
  onSortChange,
}: LotOwnerTableProps) {
  const currentSort = { column: sortColumn, dir: sortDir };

  function handleSort(column: string) {
    onSortChange?.(column);
  }

  return (
    <div>
      <div className="admin-table-wrapper">
      <table className="admin-table">
        <thead>
          <tr>
            <SortableColumnHeader
              label="Lot Number"
              column="lot_number"
              currentSort={currentSort}
              onSort={handleSort}
            />
            <th>Email</th>
            <SortableColumnHeader
              label="Unit Entitlement"
              column="unit_entitlement"
              currentSort={currentSort}
              onSort={handleSort}
            />
            <SortableColumnHeader
              label="Financial Position"
              column="financial_position"
              currentSort={currentSort}
              onSort={handleSort}
            />
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
            lotOwners.map((lo) => (
              <tr key={lo.id}>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                  {lo.lot_number}
                </td>
                <td>
                  {(lo.owner_emails ?? []).map((e) => {
                    const emailName = `${e.given_name ?? ""} ${e.surname ?? ""}`.trim();
                    return (
                      <div key={e.id} style={{ fontSize: "0.875rem" }}>
                        {emailName ? `${emailName} <${e.email ?? "—"}>` : (e.email ?? "—")}
                      </div>
                    );
                  })}
                </td>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                  {lo.unit_entitlement}
                </td>
                <td>
                  <FinancialPositionBadge position={lo.financial_position} />
                </td>
                <td style={{ fontSize: "0.875rem", color: lo.proxy_email ? "inherit" : "var(--text-muted, #888)" }}>
                  {lo.proxy_email
                    ? (lo.proxy_given_name || lo.proxy_surname)
                        ? `${lo.proxy_given_name ?? ""} ${lo.proxy_surname ?? ""}`.trim() + ` (${lo.proxy_email})`
                        : lo.proxy_email
                    : "None"}
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
    </div>
  );
}
