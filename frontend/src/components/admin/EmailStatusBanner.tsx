import React from "react";
import { useMutation } from "@tanstack/react-query";
import { resendReport } from "../../api/admin";
import type { ResendReportOut } from "../../api/admin";

interface EmailStatusBannerProps {
  meetingId: string;
  lastError: string | null;
  onRetrySuccess: () => void;
}

export default function EmailStatusBanner({
  meetingId,
  lastError,
  onRetrySuccess,
}: EmailStatusBannerProps) {
  const [retryError, setRetryError] = React.useState<string | null>(null);
  const [retrySuccess, setRetrySuccess] = React.useState(false);

  const mutation = useMutation<ResendReportOut, Error, string>({
    mutationFn: (id) => resendReport(id),
    onSuccess: () => {
      setRetrySuccess(true);
      setRetryError(null);
      onRetrySuccess();
    },
    onError: (err) => {
      setRetryError(err.message);
    },
  });

  return (
    <div role="alert" className="email-error-banner">
      <p className="email-error-banner__title">Email delivery failed.</p>
      {lastError && (
        <p className="email-error-banner__detail">{lastError}</p>
      )}
      <div className="email-error-banner__actions">
        <button
          className="btn btn--danger"
          style={{ fontSize: "0.8rem", padding: "7px 16px" }}
          onClick={() => { setRetrySuccess(false); setRetryError(null); mutation.mutate(meetingId); }}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Retrying..." : "Retry Send"}
        </button>
        {retrySuccess && (
          <span style={{ color: "var(--green)", fontSize: "0.875rem", fontWeight: 600 }}>
            ✓ Report queued for resend.
          </span>
        )}
        {retryError && (
          <span style={{ color: "var(--red)", fontSize: "0.875rem" }}>{retryError}</span>
        )}
      </div>
    </div>
  );
}
