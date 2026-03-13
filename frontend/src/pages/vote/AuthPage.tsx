import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { verifyAuth } from "../../api/voter";
import { getGeneralMeetingSummary } from "../../api/public";
import { AuthForm } from "../../components/vote/AuthForm";

export function AuthPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState("");

  // Fetch meeting summary directly — single API call to get building_id and building_name.
  // This replaces the previous O(n) parallel scan across all buildings' meeting lists,
  // which was slow and caused race conditions where the form was submitted before
  // foundBuildingId was populated.
  const { data: meetingSummary, isLoading: isSummaryLoading } = useQuery({
    queryKey: ["meeting-summary", meetingId],
    queryFn: () => getGeneralMeetingSummary(meetingId!),
    enabled: !!meetingId,
  });

  const foundBuildingId = meetingSummary?.building_id ?? null;
  const foundBuildingName = meetingSummary?.building_name ?? "";
  const meetingTitle = meetingSummary?.title ?? "";

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
      if (data.agm_status === "pending") {
        navigate("/", { state: { pendingMessage: "This meeting has not started yet. Please check back later." } });
        return;
      }
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
        isContextLoading={isSummaryLoading}
        error={authError}
      />
    </main>
  );
}

