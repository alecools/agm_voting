import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchBuildings, fetchAGMs } from "../../api/voter";
import { BuildingDropdown } from "../../components/vote/BuildingDropdown";
import { AGMList } from "../../components/vote/AGMList";

export function BuildingSelectPage() {
  const navigate = useNavigate();
  const [selectedBuildingId, setSelectedBuildingId] = useState("");
  const [buildingError, setBuildingError] = useState("");

  const { data: buildings, isLoading: buildingsLoading, isError: buildingsError } = useQuery({
    queryKey: ["buildings"],
    queryFn: fetchBuildings,
  });

  const { data: agms, isLoading: agmsLoading } = useQuery({
    queryKey: ["agms", selectedBuildingId],
    queryFn: () => fetchAGMs(selectedBuildingId),
    enabled: !!selectedBuildingId,
  });

  const handleBuildingChange = (id: string) => {
    setSelectedBuildingId(id);
    setBuildingError("");
  };

  const handleEnterVoting = (agmId: string) => {
    navigate(`/vote/${agmId}/auth`);
  };

  const handleViewSubmission = (agmId: string) => {
    navigate(`/vote/${agmId}/auth?view=submission`);
  };

  if (buildingsLoading) {
    return <p>Loading buildings...</p>;
  }

  if (buildingsError) {
    return <p role="alert">Failed to load buildings. Please try again.</p>;
  }

  return (
    <div>
      <h1>AGM Voting</h1>
      <BuildingDropdown
        /* c8 ignore next */
        buildings={buildings ?? []}
        value={selectedBuildingId}
        onChange={handleBuildingChange}
        error={buildingError}
      />
      {agmsLoading && <p>Loading AGMs...</p>}
      {agms && (
        <AGMList
          agms={agms}
          onEnterVoting={handleEnterVoting}
          onViewSubmission={handleViewSubmission}
        />
      )}
    </div>
  );
}
