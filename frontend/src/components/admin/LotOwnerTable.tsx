import { useState, useMemo } from "react";
import type { LotOwner } from "../../types";
import Pagination from "./Pagination";
import SortableColumnHeader from "./SortableColumnHeader";
import type { SortDir } from "./SortableColumnHeader";

const PAGE_SIZE = 25;

type LotOwnerSortColumn = "lot_number" | "name" | "unit_entitlement" | "financial_position" | "email" | "proxy";

interface LotOwnerTableProps {
  lotOwners: LotOwner[];
  onEdit: (lotOwner: LotOwner) => void;
  isLoading?: boolean;
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

function compareFinancialPosition(a: string, b: string): number {
  // normal < in_arrear (0 < 1)
  const order: Record<string, number> = { normal: 0, in_arrear: 1 };
  return (order[a] ?? 0) - (order[b] ?? 0);
}

export default function LotOwnerTable({ lotOwners, onEdit, isLoading }: LotOwnerTableProps) {
  const [page, setPage] = useState(1);
  const [sortState, setSortState] = useState<{ column: LotOwnerSortColumn; dir: SortDir }>({
    column: "lot_number",
    dir: "asc",
  });

  const sorted = useMemo(() => {
    const copy = [...lotOwners];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortState.column === "lot_number") {
        cmp = a.lot_number.localeCompare(b.lot_number, undefined, { numeric: true });
      } else if (sortState.column === "unit_entitlement") {
        cmp = (a.unit_entitlement ?? 0) - (b.unit_entitlement ?? 0);
      } else if (sortState.column === "financial_position") {
        cmp = compareFinancialPosition(a.financial_position, b.financial_position);
      } else if (sortState.column === "name") {
        const nameA = `${a.given_name ?? ""} ${a.surname ?? ""}`.trim();
        const nameB = `${b.given_name ?? ""} ${b.surname ?? ""}`.trim();
        cmp = nameA.localeCompare(nameB);
      } else if (sortState.column === "email") {
        const emailA = (a.emails ?? [])[0] ?? "";
        const emailB = (b.emails ?? [])[0] ?? "";
        cmp = emailA.localeCompare(emailB);
      } else if (sortState.column === "proxy") {
        // Sort by whether proxy exists (no proxy < has proxy), then by proxy email
        const hasA = a.proxy_email != null ? 1 : 0;
        const hasB = b.proxy_email != null ? 1 : 0;
        cmp = hasA - hasB;
        if (cmp === 0) {
          cmp = (a.proxy_email ?? "").localeCompare(b.proxy_email ?? "");
        }
      }
      return sortState.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [lotOwners, sortState]);

  function handleSort(column: string) {
    const col = column as LotOwnerSortColumn;
    setSortState((prev) => {
      if (prev.column === col) {
        return { column: col, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      const newDir: SortDir = "asc";
      return { column: col, dir: newDir };
    });
    setPage(1);
  }

  const currentSort = { column: sortState.column, dir: sortState.dir };

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const paginationControls = totalPages > 1 ? (
    <Pagination
      page={safePage}
      totalPages={totalPages}
      totalItems={sorted.length}
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
            <SortableColumnHeader
              label="Lot Number"
              column="lot_number"
              currentSort={currentSort}
              onSort={handleSort}
            />
            <SortableColumnHeader
              label="Name"
              column="name"
              currentSort={currentSort}
              onSort={handleSort}
            />
            <SortableColumnHeader
              label="Email"
              column="email"
              currentSort={currentSort}
              onSort={handleSort}
            />
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
            <SortableColumnHeader
              label="Proxy"
              column="proxy"
              currentSort={currentSort}
              onSort={handleSort}
            />
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && !lotOwners.length ? (
            <tr>
              <td colSpan={7} className="state-message">Loading lot owners...</td>
            </tr>
          ) : lotOwners.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px 14px" }}>
                No lot owners found.
              </td>
            </tr>
          ) : (
            visible.map((lo) => (
              <tr key={lo.id}>
                <td style={{ fontFamily: "'Overpass Mono', monospace", fontSize: "0.875rem" }}>
                  {lo.lot_number}
                </td>
                <td style={{ fontSize: "0.875rem", color: (lo.given_name || lo.surname) ? "inherit" : "var(--text-muted, #888)" }}>
                  {`${lo.given_name ?? ""} ${lo.surname ?? ""}`.trim() || "—"}
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
      {paginationControls}
    </div>
  );
}
