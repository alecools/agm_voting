import { useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { listBuildings, getBuildingsCount, createBuilding } from "../../api/admin";
import type { Building } from "../../types";
import BuildingTable from "../../components/admin/BuildingTable";
import type { SortDir } from "../../components/admin/SortableColumnHeader";
import BuildingCSVUpload from "../../components/admin/BuildingCSVUpload";
import Pagination from "../../components/admin/Pagination";
import { useState } from "react";
import { isValidEmail } from "../../utils/validation";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const PAGE_SIZE = 20;

// Text columns default to asc, date columns default to desc
const DEFAULT_SORT_DIR: Record<string, SortDir> = {
  name: "asc",
  created_at: "desc",
};

export default function BuildingsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const newBuildingBtnRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Fix 4: name filter state driven by URL params
  const nameFilterParam = searchParams.get("name_filter") ?? "";
  const [nameFilterInput, setNameFilterInput] = useState(nameFilterParam);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced URL update for name filter
  const handleNameFilterChange = useCallback(
    (val: string) => {
      setNameFilterInput(val);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const next = new URLSearchParams(searchParams);
        if (val) {
          next.set("name_filter", val);
        } else {
          next.delete("name_filter");
        }
        next.delete("page");
        setSearchParams(next, { replace: true });
      }, 300);
    },
    [searchParams, setSearchParams]
  );

  // US-ACC-02: Focus trap for New Building modal
  useEffect(() => {
    if (!showCreateModal) return;
    const focusable = modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusable && focusable.length > 0) {
      focusable[0].focus();
    }
    return () => {
      newBuildingBtnRef.current?.focus();
    };
  }, [showCreateModal]);

  // RR2-06: Read page from URL search params; default to 1
  const pageParam = parseInt(searchParams.get("page") ?? "1", 10);
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;

  // Sort state from URL search params
  const sortBy = searchParams.get("sort_by") ?? "created_at";
  const sortDir = (searchParams.get("sort_dir") ?? "desc") as SortDir;

  const { data: countData } = useQuery<{ count: number }>({
    queryKey: ["admin", "buildings", "count", showArchived, nameFilterParam],
    queryFn: () =>
      getBuildingsCount({
        is_archived: showArchived ? undefined : false,
        name: nameFilterParam || undefined,
      }),
  });

  const totalCount = countData?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const { data: buildings = [], isLoading, error } = useQuery<Building[]>({
    queryKey: ["admin", "buildings", "list", safePage, showArchived, sortBy, sortDir, nameFilterParam],
    queryFn: () =>
      listBuildings({
        limit: PAGE_SIZE,
        offset: (safePage - 1) * PAGE_SIZE,
        is_archived: showArchived ? undefined : false,
        sort_by: sortBy,
        sort_dir: sortDir,
        name: nameFilterParam || undefined,
      }),
  });

  // Prefetch next page
  useEffect(() => {
    const nextOffset = safePage * PAGE_SIZE;
    if (nextOffset < totalCount) {
      void queryClient.prefetchQuery({
        queryKey: ["admin", "buildings", "list", safePage + 1, showArchived, sortBy, sortDir, nameFilterParam],
        queryFn: () =>
          listBuildings({
            limit: PAGE_SIZE,
            offset: nextOffset,
            is_archived: showArchived ? undefined : false,
            sort_by: sortBy,
            sort_dir: sortDir,
            name: nameFilterParam || undefined,
          }),
      });
    }
  }, [safePage, showArchived, totalCount, queryClient, sortBy, sortDir, nameFilterParam]);

  const mutation = useMutation<Building, Error, { name: string; manager_email: string }>({
    mutationFn: (data) => createBuilding(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
      closeModal();
    },
    onError: (err) => {
      // When the backend returns 422 with a "Building limit reached" detail,
      // extract the message from the JSON body and show it inline.
      const raw = err.message;
      if (raw.includes("Building limit reached")) {
        try {
          const jsonStart = raw.indexOf("{");
          if (jsonStart !== -1) {
            const parsed = JSON.parse(raw.slice(jsonStart)) as { detail?: string };
            if (parsed.detail) {
              setFormError(parsed.detail);
              return;
            }
          }
        } catch {
          // fall through to generic message
        }
      }
      setFormError(raw);
    },
  });

  // RR2-06: Update URL search param on page change (use replace to avoid polluting history)
  function handlePageChange(newPage: number) {
    const next = new URLSearchParams(searchParams);
    if (newPage === 1) {
      next.delete("page");
    } else {
      next.set("page", String(newPage));
    }
    setSearchParams(next, { replace: true });
  }

  function handleShowArchivedChange(checked: boolean) {
    setShowArchived(checked);
    // RR2-03: Reset to page 1 when filter changes
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    setSearchParams(next, { replace: true });
  }

  function handleSortChange(column: string) {
    const next = new URLSearchParams(searchParams);
    // Reset page to 1 on sort change
    next.delete("page");
    if (column === sortBy) {
      // Toggle direction
      const newDir: SortDir = sortDir === "asc" ? "desc" : "asc";
      next.set("sort_by", column);
      next.set("sort_dir", newDir);
    } else {
      // New column — use its default direction (all valid columns are in DEFAULT_SORT_DIR)
      /* v8 ignore next -- "asc" fallback is unreachable: all valid sort columns are in DEFAULT_SORT_DIR */
      const newDir: SortDir = DEFAULT_SORT_DIR[column] !== undefined ? DEFAULT_SORT_DIR[column] : "asc";
      next.set("sort_by", column);
      next.set("sort_dir", newDir);
    }
    setSearchParams(next, { replace: true });
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
    if (!isValidEmail(managerEmail)) { setFormError("Please enter a valid email address."); return; }
    mutation.mutate({ name: name.trim(), manager_email: managerEmail.trim() });
  }

  function handleModalKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    /* c8 ignore next -- defensive guard; the New Building modal always has focusable elements */
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function handleCSVSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
  }

  if (error) return <p className="state-message state-message--error">Failed to load buildings.</p>;

  return (
    <div>
      <div className="admin-page-header">
        <h1>Buildings</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {/* Fix 4: name filter input */}
          <div className="field" style={{ maxWidth: 320, marginBottom: 0 }}>
            <label className="field__label" htmlFor="buildings-name-filter">Search buildings</label>
            <input
              id="buildings-name-filter"
              className="field__input"
              type="text"
              value={nameFilterInput}
              onChange={(e) => handleNameFilterChange(e.target.value)}
              placeholder="Filter by name…"
            />
          </div>
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
          <button ref={newBuildingBtnRef} className="btn btn--primary" onClick={openModal}>
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
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="New Building"
            onKeyDown={handleModalKeyDown}
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
            <p className="field__hint" style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
              <span aria-hidden="true">*</span> Required field
            </p>
            <form onSubmit={handleSubmit} noValidate>
              <div className="field">
                <label className="field__label field__label--required" htmlFor="building-name">Building Name</label>
                <input
                  id="building-name"
                  className="field__input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-required="true"
                  required
                  placeholder="e.g. Harbour View Tower"
                />
              </div>
              <div className="field">
                <label className="field__label field__label--required" htmlFor="building-manager-email">Manager Email</label>
                <input
                  id="building-manager-email"
                  className="field__input"
                  type="email"
                  value={managerEmail}
                  onChange={(e) => setManagerEmail(e.target.value)}
                  aria-required="true"
                  required
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
          isLoading={isLoading}
        />
        {/* RR2-07: Show loading overlay while fetching page change */}
        <div style={{ opacity: isLoading ? 0.5 : 1, transition: "opacity 0.15s", pointerEvents: isLoading ? "none" : "auto" }}>
          <BuildingTable
            buildings={buildings}
            isLoading={isLoading}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={handleSortChange}
          />
        </div>
        <Pagination
          page={safePage}
          totalPages={totalPages}
          totalItems={totalCount}
          pageSize={PAGE_SIZE}
          onPageChange={handlePageChange}
          isLoading={isLoading}
        />
      </div>
      <BuildingCSVUpload onSuccess={handleCSVSuccess} />
    </div>
  );
}
