import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { requestOtp, verifyAuth, restoreSession } from "../../api/voter";
import { AuthForm } from "../../components/vote/AuthForm";
import { useBranding } from "../../context/BrandingContext";

export function AuthPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const { config } = useBranding();
  const [authError, setAuthError] = useState("");
  const [authStep, setAuthStep] = useState<"email" | "code">("email");
  const [otpEmail, setOtpEmail] = useState("");
  const [isRestoringSession, setIsRestoringSession] = useState(false);

  // Shared logic: write sessionStorage keys and navigate after a successful auth response
  function handleAuthSuccess(data: Parameters<typeof verifyAuth>[0] extends infer _R ? Awaited<ReturnType<typeof verifyAuth>> : never) {
    /* c8 ignore next */
    if (!meetingId) return;
    const pendingLots = data.lots.filter((l) => !l.already_submitted);
    const pendingLotIds = pendingLots.map((l) => l.lot_owner_id);
    sessionStorage.setItem(`meeting_lots_${meetingId}`, JSON.stringify(pendingLotIds));
    sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(data.lots));
    sessionStorage.setItem(`meeting_lot_info_${meetingId}`, JSON.stringify(pendingLots));
    sessionStorage.setItem(`meeting_building_name_${meetingId}`, data.building_name);
    sessionStorage.setItem(`meeting_title_${meetingId}`, data.meeting_title);
    // Session token is now stored in an HttpOnly cookie set by the backend.
    // No localStorage write needed.
    if (data.agm_status === "pending") {
      navigate("/", { state: { pendingMessage: "This meeting has not started yet. Please check back later." } });
      return;
    }
    if (data.agm_status === "closed") {
      navigate(`/vote/${meetingId}/confirmation`);
      return;
    }
    const hasRemainingLots = data.lots.some((l) => !l.already_submitted);
    if (hasRemainingLots || data.unvoted_visible_count > 0) {
      navigate(`/vote/${meetingId}/voting`);
    } else {
      navigate(`/vote/${meetingId}/confirmation`);
    }
  }

  // On mount: attempt session restore via the HttpOnly agm_session cookie.
  // The cookie is sent automatically by the browser — no localStorage needed.
  useEffect(() => {
    if (!meetingId) return;
    setIsRestoringSession(true);
    restoreSession({ general_meeting_id: meetingId })
      .then((data) => {
        handleAuthSuccess(data);
      })
      .catch(() => {
        // Cookie is invalid/expired — show the OTP form instead.
        setIsRestoringSession(false);
      });
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      handleAuthSuccess(data);
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

  if (isRestoringSession) {
    return (
      <main className="voter-content">
        <p>Resuming your session…</p>
      </main>
    );
  }

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
      {config.support_email && (
        <p className="support-contact">
          Need help? Contact{" "}
          <a href={`mailto:${config.support_email}`}>{config.support_email}</a>
        </p>
      )}
    </main>
  );
}
