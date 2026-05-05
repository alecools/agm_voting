import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBuilding, listLotOwners, countLotOwners, archiveBuilding, updateBuilding, deleteBuilding } from "../../api/admin";
import type { Building, LotOwner } from "../../types";
import LotOwnerTable from "../../components/admin/LotOwnerTable";
import LotOwnerForm from "../../components/admin/LotOwnerForm";
import LotOwnerCSVUpload from "../../components/admin/LotOwnerCSVUpload";
import ProxyNominationsUpload from "../../components/admin/ProxyNominationsUpload";
import FinancialPositionUpload from "../../components/admin/FinancialPositionUpload";
import Pagination from "../../components/admin/Pagination";
import type { SortDir } from "../../components/admin/SortableColumnHeader";

const PAGE_SIZE = 20;

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DeleteBuildingConfirmModalProps {
  buildingName: string;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteBuildingConfirmModal({ buildingName, deleting, onConfirm, onCancel }: DeleteBuildingConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus first element on open
  useEffect(() => {
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusable && focusable.length > 0) focusable[0].focus();
  }, []);

  // Escape key dismisses (only when not loading)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !deleting) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleting, onCancel]);

  // Tab/Shift+Tab focus trap
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete Building"
      ref={dialogRef}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !deleting) onCancel(); }}
    >
      <div
        style={{
          background: "var(--white)",
          borderRadius: "var(--r-md)",
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 16 }}>Delete "{buildingName}"?</h2>
        <p style={{ marginBottom: 24, color: "var(--text-secondary)" }}>
          This action cannot be undone. All lot owners, meetings, and votes for this building will be permanently deleted.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete Building"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArchiveConfirmModalProps {
  buildingName: string;
  archiving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ArchiveConfirmModal({ buildingName, archiving, onConfirm, onCancel }: ArchiveConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // RR3-07: Focus first element on open
  useEffect(() => {
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusable && focusable.length > 0) focusable[0].focus();
  }, []);

  // RR3-07: Escape key dismisses (only when not loading)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !archiving) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [archiving, onCancel]);

  // RR3-07: Tab/Shift+Tab focus trap
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Archive Building"
      ref={dialogRef}
      onKeyDown={handleKeyDown}
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
          background: "var(--white)",
          borderRadius: "var(--r-md)",
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 16 }}>Archive "{buildingName}"?</h2>
        <p style={{ marginBottom: 24, color: "var(--text-secondary)" }}>
          Archived buildings will no longer appear in the voter portal. Lot owners who belong only
          to this building will also be archived.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={archiving}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={archiving}>
            {archiving ? "Archiving…" : "Archive"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const dialogRef = useRef<HTMLDivElement>(null);

  // RR3-07: Focus first element on open
  useEffect(() => {
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusable && focusable.length > 0) focusable[0].focus();
  }, []);

  // RR3-07: Escape key dismisses (only when not saving)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [saving, onCancel]);

  // RR3-07: Tab/Shift+Tab focus trap
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

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
      ref={dialogRef}
      onKeyDown={handleKeyDown}
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
          background: "var(--white)",
          borderRadius: "var(--r-md)",
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 20 }}>Edit Building</h2>
        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <div className="field">
            <label className="field__label" htmlFor="edit-building-name">Name</label>
            <input
              id="edit-building-name"
              type="text"
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="edit-building-manager-email">Manager Email</label>
            <input
              id="edit-building-manager-email"
              type="email"
              className="field__input"
              value={managerEmail}
              onChange={(e) => setManagerEmail(e.target.value)}
              required
            />
          </div>
          {error && <p className="field__error" style={{ marginBottom: 12 }}>{error}</p>}
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
  const [searchParams, setSearchParams] = useSearchParams();

  const [editTarget, setEditTarget] = useState<LotOwner | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Read lotPage from URL search params; default to 1
  const lotPageParam = parseInt(searchParams.get("lotPage") ?? "1", 10);
  const lotPage = isNaN(lotPageParam) || lotPageParam < 1 ? 1 : lotPageParam;

  // Sort state from URL search params
  const lotSortBy = searchParams.get("lot_sort_by") ?? "lot_number";
  const lotSortDir = (searchParams.get("lot_sort_dir") ?? "asc") as SortDir;

  const { data: building } = useQuery<Building>({
    queryKey: ["admin", "buildings", buildingId],
    queryFn: () => getBuilding(buildingId!),
    enabled: !!buildingId,
  });

  const { data: lotCountData } = useQuery<number>({
    queryKey: ["admin", "lot-owners", "count", buildingId],
    queryFn: () => countLotOwners(buildingId!),
    enabled: !!buildingId,
  });

  const totalLotCount = lotCountData ?? 0;
  const totalLotPages = Math.max(1, Math.ceil(totalLotCount / PAGE_SIZE));
  const safeLotPage = Math.min(lotPage, totalLotPages);

  const {
    data: lotOwners = [],
    isLoading,
    error,
  } = useQuery<LotOwner[]>({
    queryKey: ["admin", "lot-owners", buildingId, safeLotPage, lotSortBy, lotSortDir],
    queryFn: () =>
      listLotOwners(buildingId!, {
        limit: PAGE_SIZE,
        offset: (safeLotPage - 1) * PAGE_SIZE,
        sort_by: lotSortBy,
        sort_dir: lotSortDir,
      }),
    enabled: !!buildingId,
  });

  // Prefetch next page
  useEffect(() => {
    const nextOffset = safeLotPage * PAGE_SIZE;
    if (nextOffset < totalLotCount && buildingId) {
      void queryClient.prefetchQuery({
        queryKey: ["admin", "lot-owners", buildingId, safeLotPage + 1, lotSortBy, lotSortDir],
        queryFn: () =>
          listLotOwners(buildingId, {
            limit: PAGE_SIZE,
            offset: nextOffset,
            sort_by: lotSortBy,
            sort_dir: lotSortDir,
          }),
      });
    }
  }, [safeLotPage, totalLotCount, buildingId, queryClient, lotSortBy, lotSortDir]);

  function handleLotPageChange(newPage: number) {
    const next = new URLSearchParams(searchParams);
    if (newPage === 1) {
      next.delete("lotPage");
    } else {
      next.set("lotPage", String(newPage));
    }
    setSearchParams(next, { replace: true });
  }

  function handleLotOwnerSortChange(column: string) {
    const next = new URLSearchParams(searchParams);
    // Reset to page 1 on sort change
    next.delete("lotPage");
    if (column === lotSortBy) {
      // Toggle direction
      const newDir: SortDir = lotSortDir === "asc" ? "desc" : "asc";
      next.set("lot_sort_by", column);
      next.set("lot_sort_dir", newDir);
    } else {
      // New column — default to ascending
      next.set("lot_sort_by", column);
      next.set("lot_sort_dir", "asc");
    }
    setSearchParams(next, { replace: true });
  }

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
    void queryClient.invalidateQueries({ queryKey: ["admin", "buildings", buildingId] });
    setShowEditModal(false);
  }

  async function handleArchiveConfirm() {
    if (!buildingId) return;
    setArchiveError(null);
    setArchiving(true);
    try {
      await archiveBuilding(buildingId);
      await queryClient.invalidateQueries({ queryKey: ["admin", "buildings", buildingId] });
      navigate("/admin/buildings");
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : "Failed to archive building.");
    } finally {
      setArchiving(false);
      setShowArchiveModal(false);
    }
  }

  function handleDelete() {
    setShowDeleteModal(true);
  }

  async function handleDeleteConfirm() {
    if (!buildingId) return;
    setDeleteError(null);
    setDeleting(true);
    setShowDeleteModal(false);
    try {
      await deleteBuilding(buildingId);
      await queryClient.invalidateQueries({ queryKey: ["admin", "buildings", buildingId] });
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
              onClick={() => setShowArchiveModal(true)}
              disabled={archiving}
            >
              Archive Building
            </button>
          )}
          {building?.is_archived && (
            <button
              className="btn btn--danger"
              onClick={handleDelete}
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
        <Pagination
          page={safeLotPage}
          totalPages={totalLotPages}
          totalItems={totalLotCount}
          pageSize={PAGE_SIZE}
          onPageChange={handleLotPageChange}
          isLoading={isLoading}
        />
        <div style={{ opacity: isLoading ? 0.5 : 1, transition: "opacity 0.15s", pointerEvents: isLoading ? "none" : "auto" }}>
          <LotOwnerTable
            lotOwners={lotOwners}
            onEdit={handleEdit}
            isLoading={isLoading}
            sortColumn={lotSortBy}
            sortDir={lotSortDir}
            onSortChange={handleLotOwnerSortChange}
          />
        </div>
        <Pagination
          page={safeLotPage}
          totalPages={totalLotPages}
          totalItems={totalLotCount}
          pageSize={PAGE_SIZE}
          onPageChange={handleLotPageChange}
          isLoading={isLoading}
        />
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

      {showDeleteModal && building && (
        <DeleteBuildingConfirmModal
          buildingName={building.name}
          deleting={deleting}
          onConfirm={() => { void handleDeleteConfirm(); }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}

      {showEditModal && building && (
        <BuildingEditModal
          building={building}
          onSuccess={handleEditBuildingSuccess}
          onCancel={() => setShowEditModal(false)}
        />
      )}

      {showArchiveModal && (
        <ArchiveConfirmModal
          buildingName={building?.name ?? "this building"}
          archiving={archiving}
          onConfirm={() => { void handleArchiveConfirm(); }}
          onCancel={() => setShowArchiveModal(false)}
        />
      )}
    </div>
  );
}
