import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listGeneralMeetings, getGeneralMeetingsCount, listBuildings } from "../../api/admin";
import type { GeneralMeetingListItem } from "../../api/admin";
import type { Building } from "../../types";
import GeneralMeetingTable from "../../components/admin/GeneralMeetingTable";
import Pagination from "../../components/admin/Pagination";

const PAGE_SIZE = 20;

export default function GeneralMeetingListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedBuildingId = searchParams.get("building") ?? "";
  const selectedStatus = searchParams.get("status") ?? "";
  const [page, setPage] = useState(1);

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
    queryKey: ["admin", "general-meetings", "list", safePage, selectedBuildingId, selectedStatus],
    queryFn: () =>
      listGeneralMeetings({
        limit: PAGE_SIZE,
        offset: (safePage - 1) * PAGE_SIZE,
        building_id: selectedBuildingId || undefined,
        status: selectedStatus || undefined,
      }),
  });

  // Prefetch next page
  useEffect(() => {
    const nextOffset = safePage * PAGE_SIZE;
    if (nextOffset < totalCount) {
      void queryClient.prefetchQuery({
        queryKey: ["admin", "general-meetings", "list", safePage + 1, selectedBuildingId, selectedStatus],
        queryFn: () =>
          listGeneralMeetings({
            limit: PAGE_SIZE,
            offset: nextOffset,
            building_id: selectedBuildingId || undefined,
            status: selectedStatus || undefined,
          }),
      });
    }
  }, [safePage, selectedBuildingId, selectedStatus, totalCount, queryClient]);

  const { data: buildings = [] } = useQuery<Building[]>({
    queryKey: ["admin", "buildings", "list", 1, false],
    queryFn: () => listBuildings({ limit: 1000, offset: 0, is_archived: false }),
  });

  function handleBuildingChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("building", value);
    } else {
      next.delete("building");
    }
    setSearchParams(next);
    setPage(1);
  }

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("status", value);
    } else {
      next.delete("status");
    }
    setSearchParams(next);
    setPage(1);
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
            <div style={{ maxWidth: 280 }}>
              <label className="field__label" htmlFor="building-filter">Building</label>
              <select
                id="building-filter"
                className="field__select"
                value={selectedBuildingId}
                onChange={handleBuildingChange}
              >
                <option value="">All buildings</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
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
          onPageChange={setPage}
        />
        <GeneralMeetingTable meetings={meetings} isLoading={isLoading} />
        <Pagination
          page={safePage}
          totalPages={totalPages}
          totalItems={totalCount}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
