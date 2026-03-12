import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchBuildings, fetchGeneralMeetings } from "../../api/voter";
import { BuildingDropdown } from "../../components/vote/BuildingDropdown";
import { GeneralMeetingList } from "../../components/vote/GeneralMeetingList";

export function BuildingSelectPage() {
  const navigate = useNavigate();
  const [selectedBuildingId, setSelectedBuildingId] = useState("");
  const [buildingError, setBuildingError] = useState("");

  const { data: buildings, isLoading: buildingsLoading, isError: buildingsError } = useQuery({
    queryKey: ["buildings"],
    queryFn: fetchBuildings,
  });

  const { data: meetings, isLoading: meetingsLoading } = useQuery({
    queryKey: ["general-meetings", selectedBuildingId],
    queryFn: () => fetchGeneralMeetings(selectedBuildingId),
    enabled: !!selectedBuildingId,
  });

  const handleBuildingChange = (id: string) => {
    setSelectedBuildingId(id);
    setBuildingError("");
  };

  const handleEnterVoting = (meetingId: string) => {
    navigate(`/vote/${meetingId}/auth`);
  };

  const handleViewSubmission = (meetingId: string) => {
    navigate(`/vote/${meetingId}/auth?view=submission`);
  };

  if (buildingsLoading) {
    return (
      <main className="voter-content">
        <p className="state-message">Loading buildings...</p>
      </main>
    );
  }

  if (buildingsError) {
    return (
      <main className="voter-content">
        <p className="state-message state-message--error" role="alert">
          Failed to load buildings. Please try again.
        </p>
      </main>
    );
  }

  return (
    <main className="voter-content">
      <div className="hero">
        <span className="hero__badge">Annual General Meeting</span>
        <h1 className="hero__title">Cast Your Vote</h1>
        <p className="hero__subtitle">
          Select your building to find and vote on open General Meeting motions.
        </p>
      </div>

      <div style={{ textAlign: "right", marginBottom: "12px" }}>
        <Link to="/admin/buildings" className="btn btn--admin">
          Admin portal →
        </Link>
      </div>

      <div className="card">
        <BuildingDropdown
          /* c8 ignore next */
          buildings={buildings ?? []}
          value={selectedBuildingId}
          onChange={handleBuildingChange}
          error={buildingError}
        />
        {meetingsLoading && (
          <p className="state-message" style={{ padding: "24px 0 8px" }}>
            Loading General Meetings...
          </p>
        )}
        {meetings && (
          <GeneralMeetingList
            meetings={meetings}
            onEnterVoting={handleEnterVoting}
            onViewSubmission={handleViewSubmission}
          />
        )}
      </div>
    </main>
  );
}
