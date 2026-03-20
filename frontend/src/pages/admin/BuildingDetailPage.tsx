import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listBuildings, listLotOwners, archiveBuilding, updateBuilding, deleteBuilding } from "../../api/admin";
import type { Building, LotOwner } from "../../types";
import LotOwnerTable from "../../components/admin/LotOwnerTable";
import LotOwnerForm from "../../components/admin/LotOwnerForm";
import LotOwnerCSVUpload from "../../components/admin/LotOwnerCSVUpload";
import ProxyNominationsUpload from "../../components/admin/ProxyNominationsUpload";
import FinancialPositionUpload from "../../components/admin/FinancialPositionUpload";

interface BuildingEditModalProps {
  building: Building;
  onSuccess: () => void;
  onCancel: () => void;
}

function BuildingEditModal({ building, onSuccess, onCancel }: BuildingEditModalProps) {
  const [name, setName] = useState(building.name);
  const [managerEmail, setManagerEmail] = useState(building.manager_email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name === building.name && managerEmail === building.manager_email) {
      setError("No changes detected");
      return;
    }
    const payload: { name?: string; manager_email?: string } = {};
    if (name !== building.name) payload.name = name;
    if (managerEmail !== building.manager_email) payload.manager_email = managerEmail;
    setSaving(true);
    setError(null);
    try {
      await updateBuilding(building.id, payload);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update building.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit Building"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 20 }}>Edit Building</h2>
        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="edit-building-name" style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
              Name
            </label>
            <input
              id="edit-building-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="edit-building-manager-email" style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
              Manager Email
            </label>
            <input
              id="edit-building-manager-email"
              type="email"
              value={managerEmail}
              onChange={(e) => setManagerEmail(e.target.value)}
              required
              style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }}
            />
          </div>
          {error && <p style={{ color: "red", marginBottom: 12 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function BuildingDetailPage() {
  const { buildingId } = useParams<{ buildingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editTarget, setEditTarget] = useState<LotOwner | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  function handleEditBuildingSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
    setShowEditModal(false);
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

  async function handleDelete() {
    if (!buildingId) return;
    const confirmed = window.confirm(
      `Permanently delete "${building?.name ?? "this building"}"?\n\nThis action cannot be undone. All lot owners, meetings, and votes will be deleted.`
    );
    if (!confirmed) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteBuilding(buildingId);
      await queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
      navigate("/admin/buildings");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete building.");
    } finally {
      setDeleting(false);
    }
  }

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
          {building && (
            <button
              className="btn btn--secondary"
              onClick={() => setShowEditModal(true)}
            >
              Edit Building
            </button>
          )}
          {!building?.is_archived && (
            <button
              className="btn btn--secondary"
              onClick={() => { void handleArchive(); }}
              disabled={archiving}
            >
              {archiving ? "Archiving…" : "Archive Building"}
            </button>
          )}
          {building?.is_archived && (
            <button
              className="btn btn--secondary"
              onClick={() => { void handleDelete(); }}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete Building"}
            </button>
          )}
          <button className="btn btn--secondary" onClick={handleAddNew}>Add Lot Owner</button>
          <button className="btn btn--primary" onClick={() => navigate("/admin/general-meetings/new")}>Create General Meeting</button>
        </div>
      </div>

      {archiveError && (
        <p className="state-message state-message--error">{archiveError}</p>
      )}

      {deleteError && (
        <p className="state-message state-message--error">{deleteError}</p>
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
        <LotOwnerTable lotOwners={lotOwners} onEdit={handleEdit} isLoading={isLoading} />
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

      {showEditModal && building && (
        <BuildingEditModal
          building={building}
          onSuccess={handleEditBuildingSuccess}
          onCancel={() => setShowEditModal(false)}
        />
      )}
    </div>
  );
}
