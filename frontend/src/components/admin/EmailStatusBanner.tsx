import React from "react";
import { useMutation } from "@tanstack/react-query";
import { resendReport } from "../../api/admin";
import type { ResendReportOut } from "../../api/admin";

interface EmailStatusBannerProps {
  agmId: string;
  lastError: string | null;
  onRetrySuccess: () => void;
}

export default function EmailStatusBanner({
  agmId,
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
    <div
      role="alert"
      style={{
        background: "#f8d7da",
        border: "1px solid #f5c6cb",
        borderRadius: 4,
        padding: "12px 16px",
        marginBottom: 16,
      }}
    >
      <strong style={{ color: "#721c24" }}>Email delivery failed.</strong>
      {lastError && (
        <span style={{ color: "#721c24", marginLeft: 8 }}>{lastError}</span>
      )}
      <div style={{ marginTop: 8 }}>
        <button
          onClick={() => { setRetrySuccess(false); setRetryError(null); mutation.mutate(agmId); }}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Retrying..." : "Retry Send"}
        </button>
        {retrySuccess && (
          <span style={{ color: "#155724", marginLeft: 8 }}>Report queued for resend.</span>
        )}
        {retryError && (
          <span style={{ color: "#721c24", marginLeft: 8 }}>{retryError}</span>
        )}
      </div>
    </div>
  );
}
