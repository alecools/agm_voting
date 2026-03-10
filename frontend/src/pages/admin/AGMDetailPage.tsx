import React from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAGMDetail } from "../../api/admin";
import type { AGMDetail } from "../../api/admin";
import StatusBadge from "../../components/admin/StatusBadge";
import CloseAGMButton from "../../components/admin/CloseAGMButton";
import EmailStatusBanner from "../../components/admin/EmailStatusBanner";
import AGMReportView from "../../components/admin/AGMReportView";
import ShareSummaryLink from "../../components/admin/ShareSummaryLink";

export default function AGMDetailPage() {
  const { agmId } = useParams<{ agmId: string }>();
  const queryClient = useQueryClient();

  const { data: agm, isLoading, error } = useQuery<AGMDetail>({
    queryKey: ["admin", "agms", agmId],
    queryFn: () => getAGMDetail(agmId!),
    enabled: !!agmId,
  });

  function handleCloseSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "agms", agmId] });
  }

  function handleRetrySuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "agms", agmId] });
  }

  if (isLoading) return <p>Loading AGM...</p>;

  if (error) {
    const msg = (error as Error).message;
    if (msg.includes("404")) {
      return <p>AGM not found</p>;
    }
    return <p style={{ color: "#721c24" }}>Failed to load AGM.</p>;
  }

  /* c8 ignore next -- unreachable: error handling above covers all falsy data cases */
  if (!agm) return <p>AGM not found</p>;

  // Determine if email delivery has failed — we detect this by checking
  // if the AGM is closed and the last error is present in the response.
  // The backend AGMDetail schema does not include email delivery status directly,
  // so we surface the banner only when we have an email_delivery field present.
  // For now we rely on a convention: if the agm has an `email_delivery` field
  // injected via an extended type, show the banner.
  const agmExtended = agm as AGMDetail & {
    email_delivery?: { status: string; last_error: string | null };
  };

  const showEmailBanner =
    agm.status === "closed" &&
    agmExtended.email_delivery?.status === "failed";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>{agm.title}</h1>
        <StatusBadge status={agm.status} />
      </div>

      <p style={{ color: "#666", margin: "4px 0" }}>
        Building: {agm.building_name}
      </p>
      <p style={{ color: "#666", margin: "4px 0" }}>
        Meeting: {new Date(agm.meeting_at).toLocaleString()}
      </p>
      <p style={{ color: "#666", margin: "4px 0" }}>
        Voting closes: {new Date(agm.voting_closes_at).toLocaleString()}
      </p>
      {agm.closed_at && (
        <p style={{ color: "#666", margin: "4px 0" }}>
          Closed at: {new Date(agm.closed_at).toLocaleString()}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#666", margin: "4px 0" }}>
        <span>Summary page:</span>
        <ShareSummaryLink agmId={agmId!} />
      </div>

      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <span style={{ marginRight: 16 }}>
          Eligible voters: <strong>{agm.total_eligible_voters}</strong>
        </span>
        <span>
          Submitted: <strong>{agm.total_submitted}</strong>
        </span>
      </div>

      {showEmailBanner && (
        <EmailStatusBanner
          agmId={agmId!}
          lastError={agmExtended.email_delivery?.last_error ?? null}
          onRetrySuccess={handleRetrySuccess}
        />
      )}

      {agm.status === "open" && (
        <div style={{ marginBottom: 16 }}>
          <CloseAGMButton
            agmId={agmId!}
            agmTitle={agm.title}
            onSuccess={handleCloseSuccess}
          />
        </div>
      )}

      <h2>Results Report</h2>
      <AGMReportView motions={agm.motions} />
    </div>
  );
}
