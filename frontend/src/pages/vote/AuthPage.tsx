import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { verifyAuth } from "../../api/voter";
import { AuthForm } from "../../components/vote/AuthForm";

export function AuthPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState("");

  const mutation = useMutation({
    mutationFn: ({ email }: { email: string }) => {
      /* c8 ignore next */
      if (!meetingId) return Promise.reject(new Error("Missing meeting context"));

      return verifyAuth({
        email,
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
      // Persist building name and meeting title for the lot selection page header
      sessionStorage.setItem(`meeting_building_name_${meetingId}`, data.building_name);
      sessionStorage.setItem(`meeting_title_${meetingId}`, data.meeting_title);
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
        onSubmit={handleSubmit}
        isLoading={mutation.isPending}
        error={authError}
      />
    </main>
  );
}
