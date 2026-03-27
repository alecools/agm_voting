import { useState, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { listBuildings, getBuildingsCount, createBuilding } from "../../api/admin";
import type { Building } from "../../types";
import BuildingTable from "../../components/admin/BuildingTable";
import BuildingCSVUpload from "../../components/admin/BuildingCSVUpload";
import Pagination from "../../components/admin/Pagination";

const PAGE_SIZE = 20;

export default function BuildingsPage() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data: countData } = useQuery<{ count: number }>({
    queryKey: ["admin", "buildings", "count", showArchived],
    queryFn: () => getBuildingsCount({ is_archived: showArchived ? undefined : false }),
  });

  const totalCount = countData?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const { data: buildings = [], isLoading, error } = useQuery<Building[]>({
    queryKey: ["admin", "buildings", "list", safePage, showArchived],
    queryFn: () =>
      listBuildings({
        limit: PAGE_SIZE,
        offset: (safePage - 1) * PAGE_SIZE,
        is_archived: showArchived ? undefined : false,
      }),
  });

  // Prefetch next page
  useEffect(() => {
    const nextOffset = safePage * PAGE_SIZE;
    if (nextOffset < totalCount) {
      void queryClient.prefetchQuery({
        queryKey: ["admin", "buildings", "list", safePage + 1, showArchived],
        queryFn: () =>
          listBuildings({
            limit: PAGE_SIZE,
            offset: nextOffset,
            is_archived: showArchived ? undefined : false,
          }),
      });
    }
  }, [safePage, showArchived, totalCount, queryClient]);

  const mutation = useMutation<Building, Error, { name: string; manager_email: string }>({
    mutationFn: (data) => createBuilding(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
      closeModal();
    },
    onError: (err) => {
      setFormError(err.message);
    },
  });

  function handlePageChange(newPage: number) {
    setPage(newPage);
  }

  function handleShowArchivedChange(checked: boolean) {
    setShowArchived(checked);
    setPage(1);
  }

  function openModal() {
    setName("");
    setManagerEmail("");
    setFormError(null);
    setShowCreateModal(true);
  }

  function closeModal() {
    setShowCreateModal(false);
    setName("");
    setManagerEmail("");
    setFormError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) { setFormError("Building name is required."); return; }
    if (!managerEmail.trim()) { setFormError("Manager email is required."); return; }
    mutation.mutate({ name: name.trim(), manager_email: managerEmail.trim() });
  }

  function handleCSVSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
  }

  if (error) return <p className="state-message state-message--error">Failed to load buildings.</p>;

  return (
    <div>
      <div className="admin-page-header">
        <h1>Buildings</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label className="toggle-switch">
            <input
              id="show-archived-toggle"
              className="toggle-switch__input"
              type="checkbox"
              checked={showArchived}
              onChange={(e) => handleShowArchivedChange(e.target.checked)}
            />
            <span className="toggle-switch__track" />
            Show archived
          </label>
          <button className="btn btn--primary" onClick={openModal}>
            + New Building
          </button>
        </div>
      </div>

      {showCreateModal && (
        <>
          {/* Backdrop */}
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200 }}
            onClick={closeModal}
          />
          {/* Panel */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="New Building"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(480px, 90vw)",
              zIndex: 201,
              background: "white",
              borderRadius: "var(--r-lg)",
              padding: "1.5rem",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <h3 className="admin-card__title">New Building</h3>
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label className="field__label" htmlFor="building-name">Building Name</label>
                <input
                  id="building-name"
                  className="field__input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Harbour View Tower"
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="building-manager-email">Manager Email</label>
                <input
                  id="building-manager-email"
                  className="field__input"
                  type="email"
                  value={managerEmail}
                  onChange={(e) => setManagerEmail(e.target.value)}
                  placeholder="e.g. manager@example.com"
                />
              </div>
              {formError && (
                <span role="alert" className="field__error">{formError}</span>
              )}
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={mutation.isPending}
                >
                  {mutation.isPending ? "Creating..." : "Create Building"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={closeModal}
                  disabled={mutation.isPending}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      <div className="admin-card">
        <Pagination
          page={safePage}
          totalPages={totalPages}
          totalItems={totalCount}
          pageSize={PAGE_SIZE}
          onPageChange={handlePageChange}
        />
        <BuildingTable buildings={buildings} isLoading={isLoading} />
        <Pagination
          page={safePage}
          totalPages={totalPages}
          totalItems={totalCount}
          pageSize={PAGE_SIZE}
          onPageChange={handlePageChange}
        />
      </div>
      <BuildingCSVUpload onSuccess={handleCSVSuccess} />
    </div>
  );
}
