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

  const { data: meetings = [], isLoading, error } = useQuery<GeneralMeetingListItem[]>({
    queryKey: ["admin", "general-meetings"],
    queryFn: listGeneralMeetings,
  });

  const { data: buildings = [] } = useQuery<Building[]>({
    queryKey: ["admin", "buildings"],
    queryFn: listBuildings,
  });

  const filteredMeetings = selectedBuildingId
    ? meetings.filter((m) => m.building_id === selectedBuildingId)
    : meetings;

  function handleBuildingChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    if (value) {
      setSearchParams({ building: value });
    } else {
      setSearchParams({});
    }
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
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="building-filter" style={{ marginRight: "0.5rem", fontWeight: 500 }}>
            Building:
          </label>
          <select
            id="building-filter"
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
        <GeneralMeetingTable meetings={filteredMeetings} isLoading={isLoading} />
      </div>
    </div>
  );
}
