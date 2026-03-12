import { useParams, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
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

  if (isLoading) return <p className="state-message">Loading AGM...</p>;

  if (error) {
    const msg = (error as Error).message;
    if (msg.includes("404")) return <p className="state-message">AGM not found</p>;
    return <p className="state-message state-message--error">Failed to load AGM.</p>;
  }

  /* c8 ignore next -- unreachable: error handling above covers all falsy data cases */
  if (!agm) return <p className="state-message">AGM not found</p>;

  const agmExtended = agm as AGMDetail & {
    email_delivery?: { status: string; last_error: string | null };
  };

  const showEmailBanner =
    agm.status === "closed" &&
    agmExtended.email_delivery?.status === "failed";

  return (
    <div>
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/admin/agms")}>
        ← Back
      </button>
      <div className="admin-page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0 }}>{agm.title}</h1>
          <StatusBadge status={agm.status} />
        </div>
        {agm.status === "open" && (
          <CloseAGMButton
            agmId={agmId!}
            agmTitle={agm.title}
            onSuccess={handleCloseSuccess}
          />
        )}
      </div>

      <div className="admin-meta">
        <span className="admin-meta__item">
          <span className="admin-meta__label">Building</span>
          {agm.building_name}
        </span>
        <span className="admin-meta__item">
          <span className="admin-meta__label">Meeting</span>
          {new Date(agm.meeting_at).toLocaleString()}
        </span>
        <span className="admin-meta__item">
          <span className="admin-meta__label">Voting closes</span>
          {new Date(agm.voting_closes_at).toLocaleString()}
        </span>
        {agm.closed_at && (
          <span className="admin-meta__item">
            <span className="admin-meta__label">Closed at</span>
            {new Date(agm.closed_at).toLocaleString()}
          </span>
        )}
        <span className="admin-meta__item">
          <span className="admin-meta__label">Summary</span>
          <ShareSummaryLink agmId={agmId!} />
        </span>
      </div>

      <div className="admin-stats">
        <div className="admin-stats__item">
          <span className="admin-stats__label">Eligible voters</span>
          <span className="admin-stats__value">{agm.total_eligible_voters}</span>
        </div>
        <div className="admin-stats__item">
          <span className="admin-stats__label">Submitted</span>
          <span className="admin-stats__value">{agm.total_submitted}</span>
        </div>
        <div className="admin-stats__item">
          <span className="admin-stats__label">Participation</span>
          <span className="admin-stats__value">
            {agm.total_eligible_voters > 0
              ? Math.round((agm.total_submitted / agm.total_eligible_voters) * 100)
              : 0}%
          </span>
        </div>
      </div>

      {showEmailBanner && (
        <EmailStatusBanner
          agmId={agmId!}
          lastError={agmExtended.email_delivery?.last_error ?? null}
          onRetrySuccess={handleRetrySuccess}
        />
      )}

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Results Report</h2>
      <AGMReportView motions={agm.motions} agmTitle={agm.title} />
    </div>
  );
}
