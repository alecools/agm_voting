import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listGeneralMeetings, getGeneralMeetingsCount } from "../../api/admin";
import type { GeneralMeetingListItem } from "../../api/admin";
import GeneralMeetingTable from "../../components/admin/GeneralMeetingTable";
import type { SortDir } from "../../components/admin/SortableColumnHeader";
import Pagination from "../../components/admin/Pagination";
import BuildingSearchCombobox from "../../components/admin/BuildingSearchCombobox";

const PAGE_SIZE = 20;

// Text columns default to asc, date columns default to desc
const DEFAULT_SORT_DIR: Record<string, SortDir> = {
  title: "asc",
  building_name: "asc",
  created_at: "desc",
};

export default function GeneralMeetingListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedBuildingId = searchParams.get("building") ?? "";
  const selectedStatus = searchParams.get("status") ?? "";

  // RR2-06: Read page from URL search params; default to 1
  const pageParam = parseInt(searchParams.get("page") ?? "1", 10);
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;

  // Sort state from URL search params
  const sortBy = searchParams.get("sort_by") ?? "created_at";
  const sortDir = (searchParams.get("sort_dir") ?? "desc") as SortDir;

  function handleBuildingChange(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) {
      next.set("building", id);
    } else {
      next.delete("building");
    }
    next.delete("page");
    setSearchParams(next);
  }

  const { data: countData } = useQuery<{ count: number }>({
    queryKey: ["admin", "general-meetings", "count", selectedBuildingId, selectedStatus],
    queryFn: () =>
      getGeneralMeetingsCount({
        building_id: selectedBuildingId || undefined,
        status: selectedStatus || undefined,
      }),
  });

  const totalCount = countData?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const { data: meetings = [], isLoading, error } = useQuery<GeneralMeetingListItem[]>({
    queryKey: ["admin", "general-meetings", "list", safePage, selectedBuildingId, selectedStatus, sortBy, sortDir],
    queryFn: () =>
      listGeneralMeetings({
        limit: PAGE_SIZE,
        offset: (safePage - 1) * PAGE_SIZE,
        building_id: selectedBuildingId || undefined,
        status: selectedStatus || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
      }),
  });

  // Prefetch next page
  useEffect(() => {
    const nextOffset = safePage * PAGE_SIZE;
    if (nextOffset < totalCount) {
      void queryClient.prefetchQuery({
        queryKey: ["admin", "general-meetings", "list", safePage + 1, selectedBuildingId, selectedStatus, sortBy, sortDir],
        queryFn: () =>
          listGeneralMeetings({
            limit: PAGE_SIZE,
            offset: nextOffset,
            building_id: selectedBuildingId || undefined,
            status: selectedStatus || undefined,
            sort_by: sortBy,
            sort_dir: sortDir,
          }),
      });
    }
  }, [safePage, selectedBuildingId, selectedStatus, totalCount, queryClient, sortBy, sortDir]);

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("status", value);
    } else {
      next.delete("status");
    }
    // Reset page to 1 when filter changes
    next.delete("page");
    setSearchParams(next);
  }

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

  if (error) return <p className="state-message state-message--error">Failed to load General Meetings.</p>;

  return (
    <div>
      <div className="admin-page-header">
        <h1>General Meetings</h1>
        <button className="btn btn--primary" onClick={() => navigate("/admin/general-meetings/new")}>
          Create General Meeting
        </button>
      </div>
      <div className="admin-card">
        <div className="admin-card__header">
          <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
            {/* Building search combobox */}
            <div style={{ maxWidth: 280 }}>
              <label className="field__label" htmlFor="building-combobox">Building</label>
              <BuildingSearchCombobox
                id="building-combobox"
                value={selectedBuildingId}
                onChange={(id) => handleBuildingChange(id)}
                placeholder="All buildings"
              />
            </div>

            <div style={{ maxWidth: 180 }}>
              <label className="field__label" htmlFor="status-filter">Status</label>
              <select
                id="status-filter"
                className="field__select"
                value={selectedStatus}
                onChange={handleStatusChange}
              >
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>
        </div>
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
          <GeneralMeetingTable
            meetings={meetings}
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
    </div>
  );
}
