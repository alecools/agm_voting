import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { requestOtp, verifyAuth } from "../../api/voter";
import { AuthForm } from "../../components/vote/AuthForm";

export function AuthPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState("");
  const [authStep, setAuthStep] = useState<"email" | "code">("email");
  const [otpEmail, setOtpEmail] = useState("");

  const requestOtpMutation = useMutation({
    mutationFn: ({ email }: { email: string }) => {
      /* c8 ignore next */
      if (!meetingId) return Promise.reject(new Error("Missing meeting context"));
      return requestOtp({ email, general_meeting_id: meetingId });
    },
    onSuccess: () => {
      setAuthError("");
      setAuthStep("code");
    },
    onError: () => {
      setAuthError("Failed to send code. Please try again.");
    },
  });

  const verifyMutation = useMutation({
    mutationFn: ({ email, code }: { email: string; code: string }) => {
      /* c8 ignore next */
      if (!meetingId) return Promise.reject(new Error("Missing meeting context"));
      return verifyAuth({ email, code, general_meeting_id: meetingId });
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
        navigate(`/vote/${meetingId}/voting`);
      }
    },
    onError: (error: Error) => {
      if (error.message.includes("401")) {
        setAuthError("Invalid or expired code. Please try again.");
      } else {
        setAuthError("An error occurred. Please try again.");
      }
    },
  });

  const handleRequestOtp = (email: string) => {
    setAuthError("");
    setOtpEmail(email);
    requestOtpMutation.mutate({ email });
  };

  const handleVerify = (email: string, code: string) => {
    setAuthError("");
    verifyMutation.mutate({ email, code });
  };

  return (
    <main className="voter-content">
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/")}>
        ← Back
      </button>
      <AuthForm
        onRequestOtp={handleRequestOtp}
        onVerify={handleVerify}
        isRequestingOtp={requestOtpMutation.isPending}
        isVerifying={verifyMutation.isPending}
        step={authStep}
        otpEmail={otpEmail}
        error={authError}
      />
    </main>
  );
}
