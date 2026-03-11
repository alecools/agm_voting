import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Building } from "../../types";
import Pagination from "./Pagination";

const PAGE_SIZE = 20;

interface BuildingTableProps {
  buildings: Building[];
}

export default function BuildingTable({ buildings }: BuildingTableProps) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(buildings.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = buildings.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Manager Email</th>
            <th>Status</th>
            <th>Created At</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((b) => (
            <tr key={b.id} style={b.is_archived ? { opacity: 0.6 } : undefined}>
              <td>
                <button
                  className="admin-table__link"
                  onClick={() => navigate(`/admin/buildings/${b.id}`)}
                >
                  {b.name}
                </button>
              </td>
              <td>{b.manager_email}</td>
              <td>
                {b.is_archived && (
                  <span
                    className="status-badge status-badge--archived"
                    style={{
                      fontSize: "0.75rem",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      background: "var(--text-muted, #888)",
                      color: "#fff",
                    }}
                  >
                    Archived
                  </span>
                )}
              </td>
              <td style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>
                {new Date(b.created_at).toLocaleString()}
              </td>
            </tr>
          ))}
          {buildings.length === 0 && (
            <tr>
              <td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: "32px 14px" }}>
                No buildings found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <Pagination
        page={safePage}
        totalPages={totalPages}
        totalItems={buildings.length}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}
