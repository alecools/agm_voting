import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listGeneralMeetings, listBuildings } from "../../api/admin";
import type { GeneralMeetingListItem } from "../../api/admin";
import type { Building } from "../../types";
import GeneralMeetingTable from "../../components/admin/GeneralMeetingTable";

export default function GeneralMeetingListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedBuildingId = searchParams.get("building") ?? "";
  const selectedStatus = searchParams.get("status") ?? "";

  const { data: meetings = [], isLoading, error } = useQuery<GeneralMeetingListItem[]>({
    queryKey: ["admin", "general-meetings"],
    queryFn: listGeneralMeetings,
  });

  const { data: buildings = [] } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  const activeBuildings = buildings.filter((b) => !b.is_archived);

  const filteredMeetings = meetings
    .filter((m) => !selectedBuildingId || m.building_id === selectedBuildingId)
    .filter((m) => !selectedStatus || m.status === selectedStatus);

  function handleBuildingChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("building", value);
    } else {
      next.delete("building");
    }
    setSearchParams(next);
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
                {activeBuildings.map((b) => (
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
        <GeneralMeetingTable meetings={filteredMeetings} isLoading={isLoading} />
      </div>
    </div>
  );
}
