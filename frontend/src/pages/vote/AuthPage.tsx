import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchBuildings, fetchGeneralMeetings, verifyAuth } from "../../api/voter";
import { AuthForm } from "../../components/vote/AuthForm";

export function AuthPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState("");

  // We need building info — fetch all buildings then find the one for this meeting
  const { data: buildings } = useQuery({
    queryKey: ["buildings"],
    queryFn: fetchBuildings,
  });

  // Find which building has this meeting
  const [foundBuildingId, setFoundBuildingId] = useState<string | null>(null);
  const [foundBuildingName, setFoundBuildingName] = useState<string>("");
  const [meetingTitle, setMeetingTitle] = useState<string>("");

  useEffect(() => {
    if (!buildings || !meetingId) return;

    const findBuilding = async () => {
      for (const building of buildings) {
        try {
          const meetings = await fetchGeneralMeetings(building.id);
          const found = meetings.find((a) => a.id === meetingId);
          if (found) {
            setFoundBuildingId(building.id);
            setFoundBuildingName(building.name);
            setMeetingTitle(found.title);
            return;
          }
        } catch {
          // continue searching
        }
      }
    };

    void findBuilding();
  }, [buildings, meetingId]);

  const mutation = useMutation({
    mutationFn: ({ email }: { email: string }) => {
      if (!foundBuildingId || !meetingId) {
        return Promise.reject(new Error("Missing building or meeting context"));
      }
      return verifyAuth({
        email,
        building_id: foundBuildingId,
        general_meeting_id: meetingId,
      });
    },
    onSuccess: (data) => {
      /* c8 ignore next */
      if (!meetingId) return;
      const allSubmitted = data.lots.length > 0 && data.lots.every((l) => l.already_submitted);
      const pendingLots = data.lots.filter((l) => !l.already_submitted);
      const pendingLotIds = pendingLots.map((l) => l.lot_owner_id);
      // Persist pending lot IDs in sessionStorage so VotingPage can submit on behalf of them
      sessionStorage.setItem(`meeting_lots_${meetingId}`, JSON.stringify(pendingLotIds));
      // Persist full lot info (including is_proxy) for the lot selection screen
      sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(data.lots));
      // Persist lot info (including financial_position) so VotingPage can enforce eligibility
      sessionStorage.setItem(`meeting_lot_info_${meetingId}`, JSON.stringify(pendingLots));
      if (data.agm_status === "closed" || allSubmitted) {
        navigate(`/vote/${meetingId}/confirmation`);
      } else {
        navigate(`/vote/${meetingId}/lot-selection`);
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

  const handleSubmit = (_lotNumber: string, email: string) => {
    setAuthError("");
    mutation.mutate({ email });
  };

  return (
    <main className="voter-content">
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/")}>
        ← Back
      </button>
      <AuthForm
        agmTitle={meetingTitle || "Loading..."}
        buildingName={foundBuildingName || ""}
        onSubmit={handleSubmit}
        isLoading={mutation.isPending}
        error={authError}
      />
    </main>
  );
}

