import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listBuildings, listLotOwners, archiveBuilding } from "../../api/admin";
import type { Building, LotOwner } from "../../types";
import LotOwnerTable from "../../components/admin/LotOwnerTable";
import LotOwnerForm from "../../components/admin/LotOwnerForm";
import LotOwnerCSVUpload from "../../components/admin/LotOwnerCSVUpload";
import ProxyNominationsUpload from "../../components/admin/ProxyNominationsUpload";
import FinancialPositionUpload from "../../components/admin/FinancialPositionUpload";

export default function BuildingDetailPage() {
  const { buildingId } = useParams<{ buildingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editTarget, setEditTarget] = useState<LotOwner | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const { data: buildings = [] } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  const building = buildings.find((b) => b.id === buildingId);

  const {
    data: lotOwners = [],
    isLoading,
    error,
  } = useQuery<LotOwner[]>({
    queryKey: ["admin", "lot-owners", buildingId],
    queryFn: () => listLotOwners(buildingId!),
    enabled: !!buildingId,
  });

  function handleEdit(lo: LotOwner) {
    setEditTarget(lo);
    setShowForm(true);
  }

  function handleAddNew() {
    setEditTarget(null);
    setShowForm(true);
  }

  function handleFormSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", buildingId] });
    setShowForm(false);
    setEditTarget(null);
  }

  function handleFormCancel() {
    setShowForm(false);
    setEditTarget(null);
  }

  function handleCSVSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "lot-owners", buildingId] });
  }

  async function handleArchive() {
    if (!buildingId) return;
    const confirmed = window.confirm(
      `Archive "${building?.name ?? "this building"}"?\n\nArchived buildings will no longer appear in the voter portal. Lot owners who belong only to this building will also be archived.`
    );
    if (!confirmed) return;
    setArchiveError(null);
    setArchiving(true);
    try {
      await archiveBuilding(buildingId);
      await queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
      navigate("/admin/buildings");
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : "Failed to archive building.");
    } finally {
      setArchiving(false);
    }
  }

  if (isLoading) return <p className="state-message">Loading lot owners...</p>;
  if (error) return <p className="state-message state-message--error">Failed to load lot owners.</p>;

  return (
    <div>
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/admin/buildings")}>
        ← Back
      </button>
      <div className="admin-page-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ marginBottom: 2 }}>{building ? building.name : "Building"}</h1>
            {building?.is_archived && (
              <span
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
          </div>
          {building && (
            <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-muted)" }}>
              {building.manager_email}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!building?.is_archived && (
            <button
              className="btn btn--secondary"
              onClick={() => { void handleArchive(); }}
              disabled={archiving}
            >
              {archiving ? "Archiving…" : "Archive Building"}
            </button>
          )}
          <button className="btn btn--secondary" onClick={handleAddNew}>Add Lot Owner</button>
          <button className="btn btn--primary" onClick={() => navigate("/admin/agms/new")}>Create AGM</button>
        </div>
      </div>

      {archiveError && (
        <p className="state-message state-message--error">{archiveError}</p>
      )}

      {showForm && (
        <LotOwnerForm
          buildingId={buildingId!}
          editTarget={editTarget}
          onSuccess={handleFormSuccess}
          onCancel={handleFormCancel}
        />
      )}

      <div className="admin-card">
        <LotOwnerTable lotOwners={lotOwners} onEdit={handleEdit} />
      </div>

      <LotOwnerCSVUpload
        buildingId={buildingId!}
        onSuccess={handleCSVSuccess}
      />

      <ProxyNominationsUpload
        buildingId={buildingId!}
        onSuccess={handleCSVSuccess}
      />

      <FinancialPositionUpload
        buildingId={buildingId!}
        onSuccess={handleCSVSuccess}
      />
    </div>
  );
}
