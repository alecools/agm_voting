import React, { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchAGMs, fetchBuildings, verifyAuth } from "../../api/voter";
import { AuthForm } from "../../components/vote/AuthForm";

export function AuthPage() {
  const { agmId } = useParams<{ agmId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState("");

  const viewMode = searchParams.get("view");

  // We need building info — fetch all buildings then find the one for this AGM
  // We get building_id from the AGM list by querying all buildings and their AGMs.
  // For simplicity, we store building_id in the AGM list fetch.
  // Strategy: fetch all buildings, then for each building fetch AGMs to find our AGM.
  // Better: we load all buildings, then when user picks the AGM we already have building_id.
  // Since we navigate here from BuildingSelectPage which has the building context in query cache,
  // we use a query that finds the agm from all buildings.

  const { data: buildings } = useQuery({
    queryKey: ["buildings"],
    queryFn: fetchBuildings,
  });

  // Find which building has this AGM
  // We query all AGMs per building to find the right one
  const [foundBuildingId, setFoundBuildingId] = React.useState<string | null>(null);
  const [foundBuildingName, setFoundBuildingName] = React.useState<string>("");
  const [agmTitle, setAgmTitle] = React.useState<string>("");

  React.useEffect(() => {
    if (!buildings || !agmId) return;

    const findBuilding = async () => {
      for (const building of buildings) {
        try {
          const { fetchAGMs: fetch } = await import("../../api/voter");
          const agms = await fetch(building.id);
          const found = agms.find((a) => a.id === agmId);
          if (found) {
            setFoundBuildingId(building.id);
            setFoundBuildingName(building.name);
            setAgmTitle(found.title);
            return;
          }
        } catch {
          // continue searching
        }
      }
    };

    void findBuilding();
  }, [buildings, agmId]);

  const mutation = useMutation({
    mutationFn: ({ lotNumber, email }: { lotNumber: string; email: string }) => {
      if (!foundBuildingId || !agmId) {
        return Promise.reject(new Error("Missing building or AGM context"));
      }
      return verifyAuth({
        lot_number: lotNumber,
        email,
        building_id: foundBuildingId,
        agm_id: agmId,
      });
    },
    onSuccess: (data) => {
      /* c8 ignore next */
      if (!agmId) return;
      if (data.agm_status === "closed" || data.already_submitted) {
        navigate(`/vote/${agmId}/confirmation`);
      } else {
        navigate(`/vote/${agmId}/voting`);
      }
    },
    onError: (error: Error) => {
      if (error.message.includes("401")) {
        setAuthError("Lot number and email address do not match our records");
      } else {
        setAuthError("An error occurred. Please try again.");
      }
    },
  });

  const handleSubmit = (lotNumber: string, email: string) => {
    setAuthError("");
    mutation.mutate({ lotNumber, email });
  };

  return (
    <AuthForm
      agmTitle={agmTitle || "Loading..."}
      buildingName={foundBuildingName || ""}
      onSubmit={handleSubmit}
      isLoading={mutation.isPending}
      error={authError}
    />
  );
}
