import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listBuildings } from "../../api/admin";
import type { Building } from "../../types";
import BuildingTable from "../../components/admin/BuildingTable";
import BuildingCSVUpload from "../../components/admin/BuildingCSVUpload";
import BuildingForm from "../../components/admin/BuildingForm";

export default function BuildingsPage() {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const { data: buildings = [], isLoading, error } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  const visibleBuildings = showArchived
    ? buildings
    : buildings.filter((b) => !b.is_archived);

  function handleSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
    setShowCreateForm(false);
  }

  if (error) return <p className="state-message state-message--error">Failed to load buildings.</p>;

  return (
    <div>
      <div className="admin-page-header">
        <h1>Buildings</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.875rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          {!showCreateForm && (
            <button className="btn btn--primary" onClick={() => setShowCreateForm(true)}>
              + New Building
            </button>
          )}
        </div>
      </div>
      {showCreateForm && (
        <BuildingForm onSuccess={handleSuccess} onCancel={() => setShowCreateForm(false)} />
      )}
      <div className="admin-card">
        <BuildingTable buildings={visibleBuildings} isLoading={isLoading} />
      </div>
      <BuildingCSVUpload onSuccess={handleSuccess} />
    </div>
  );
}
