import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { requestOtp, verifyAuth, restoreSession } from "../../api/voter";
import type { AuthVerifyResponse } from "../../api/voter";
import { AuthForm } from "../../components/vote/AuthForm";
import { useBranding } from "../../context/BrandingContext";

// ---------------------------------------------------------------------------
// Channel selector modal
// ---------------------------------------------------------------------------

interface ChannelModalProps {
  channel: "email" | "sms";
  onChannelChange: (c: "email" | "sms") => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSending: boolean;
  error: string;
  enabledChannels: string[];
}

function ChannelModal({
  channel,
  onChannelChange,
  onConfirm,
  onCancel,
  isSending,
  error,
  enabledChannels,
}: ChannelModalProps) {
  // Focus trap: move focus into the dialog on mount
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose verification method"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        className="channel-modal"
        style={{
          background: "#fff",
          borderRadius: "var(--r-md)",
          padding: 32,
          minWidth: 320,
          maxWidth: 440,
          width: "100%",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 className="channel-modal__heading">
          Choose verification method
        </h2>

        <div
          role="radiogroup"
          aria-label="Verification channel"
          className="channel-modal__radiogroup"
        >
          {enabledChannels.includes("email") && (
            <label className="channel-modal__radio-label">
              <input
                type="radio"
                name="otp-channel"
                value="email"
                checked={channel === "email"}
                onChange={() => onChannelChange("email")}
              />
              Email
            </label>
          )}
          {enabledChannels.includes("sms") && (
            <label className="channel-modal__radio-label">
              <input
                type="radio"
                name="otp-channel"
                value="sms"
                checked={channel === "sms"}
                onChange={() => onChannelChange("sms")}
              />
              SMS
            </label>
          )}
        </div>

        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}

        <div className="channel-modal__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
            disabled={isSending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={isSending}
            onClick={onConfirm}
          >
            {isSending ? "Sending…" : "Send code"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuthPage
// ---------------------------------------------------------------------------

export function AuthPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const { config } = useBranding();
  const [authError, setAuthError] = useState("");
  const [authStep, setAuthStep] = useState<"email" | "code">("email");
  const [otpEmail, setOtpEmail] = useState("");
  const [showChannelModal, setShowChannelModal] = useState(false);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [phoneHint, setPhoneHint] = useState<string | null>(null);
  const [enabledChannels, setEnabledChannels] = useState<string[]>(["email"]);
  const [isRestoringSession, setIsRestoringSession] = useState(false);

  // Ref to the "Send Verification Code" button — used to restore focus when ChannelModal closes
  const sendCodeButtonRef = useRef<HTMLButtonElement>(null);
  const prevShowModalRef = useRef(false);

  // Return focus to send-code button when the channel modal closes (ACCESSIBILITY-3)
  useEffect(() => {
    if (prevShowModalRef.current && !showChannelModal) {
      sendCodeButtonRef.current?.focus();
    }
    prevShowModalRef.current = showChannelModal;
  }, [showChannelModal]);

  // Shared logic: write sessionStorage keys and navigate after a successful auth response
  const handleAuthSuccess = useCallback((data: AuthVerifyResponse) => {
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
  }, [meetingId, navigate]);

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
  }, [meetingId, handleAuthSuccess]);

  const requestOtpMutation = useMutation({
    mutationFn: ({ email, otpChannel }: { email: string; otpChannel?: "email" | "sms" }) => {
      /* c8 ignore next */
      if (!meetingId) return Promise.reject(new Error("Missing meeting context"));
      return requestOtp({ email, general_meeting_id: meetingId, channel: otpChannel });
    },
    onSuccess: (data, variables) => {
      setAuthError("");
      // First call (no channel specified): use enabled_channels to decide flow
      if (variables.otpChannel === undefined) {
        const channels = data.enabled_channels ?? ["email"];
        setEnabledChannels(channels);
        const multiChannel = channels.length > 1;
        if (multiChannel && data.has_phone) {
          // Multiple channels available and voter has a phone: show selector
          setPhoneHint(data.phone_hint ?? null);
          setChannel("email");
          setShowChannelModal(true);
        } else {
          // Single channel or no phone: OTP already sent, go straight to code entry
          setPhoneHint(data.phone_hint ?? null);
          setAuthStep("code");
        }
      } else {
        // Second call with explicit channel: store hint and go to code entry
        setPhoneHint(data.phone_hint ?? null);
        setShowChannelModal(false);
        setAuthStep("code");
      }
    },
    onError: (error: Error, variables) => {
      if (variables.otpChannel === "sms" && error.message.includes("422")) {
        setAuthError("SMS could not be sent. Please choose email instead.");
        // Keep the channel modal visible so the user can switch to email
      } else if (variables.otpChannel === "sms" && error.message.includes("503")) {
        // SMS was disabled by admin between the first (auto-send) call and the
        // channel-confirm call. Remove SMS from the list and, if only email
        // remains, hide the modal and advance to code entry (Bug 1 fix).
        const remainingChannels = ["email"];
        setEnabledChannels(remainingChannels);
        setShowChannelModal(false);
        setChannel("email");
        setAuthError("SMS is no longer available. Your code has been sent by email.");
        setAuthStep("code");
      } else {
        setAuthError("Failed to send code. Please try again.");
        if (variables.otpChannel !== undefined) {
          // Error on the channel-selection send: keep modal open to retry
        }
      }
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

  const handleChannelConfirm = () => {
    setAuthError("");
    requestOtpMutation.mutate({ email: otpEmail, otpChannel: channel });
  };

  const handleChannelCancel = () => {
    setShowChannelModal(false);
    setAuthError("");
    setChannel("email");
  };

  const handleVerify = (email: string, code: string) => {
    setAuthError("");
    verifyMutation.mutate({ email, code });
  };

  if (isRestoringSession) {
    return (
      <main className="voter-content">
        <p role="status">Resuming your session…</p>
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
        error={showChannelModal ? "" : authError}
        smsChannel={channel === "sms"}
        phoneHint={phoneHint}
        triggerRef={sendCodeButtonRef}
      />

      {showChannelModal && (
        <ChannelModal
          channel={channel}
          onChannelChange={setChannel}
          onConfirm={handleChannelConfirm}
          onCancel={handleChannelCancel}
          isSending={requestOtpMutation.isPending}
          error={authError}
          enabledChannels={enabledChannels}
        />
      )}

      {config.support_email && (
        <p className="support-contact">
          Need help? Contact{" "}
          <a href={`mailto:${config.support_email}`}>{config.support_email}</a>
        </p>
      )}
    </main>
  );
}
