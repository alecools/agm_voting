import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getGeneralMeetingDetail } from "../../api/admin";
import type { GeneralMeetingDetail } from "../../api/admin";
import StatusBadge from "../../components/admin/StatusBadge";
import CloseGeneralMeetingButton from "../../components/admin/CloseGeneralMeetingButton";
import StartGeneralMeetingButton from "../../components/admin/StartGeneralMeetingButton";
import EmailStatusBanner from "../../components/admin/EmailStatusBanner";
import AGMReportView from "../../components/admin/AGMReportView";
import ShareSummaryLink from "../../components/admin/ShareSummaryLink";

export default function GeneralMeetingDetailPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: meeting, isLoading, error } = useQuery<GeneralMeetingDetail>({
    queryKey: ["admin", "general-meetings", meetingId],
    queryFn: () => getGeneralMeetingDetail(meetingId!),
    enabled: !!meetingId,
  });

  function handleCloseSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  }

  function handleRetrySuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  }

  if (isLoading) return <p className="state-message">Loading General Meeting...</p>;

  if (error) {
    const msg = (error as Error).message;
    if (msg.includes("404")) return <p className="state-message">General Meeting not found</p>;
    return <p className="state-message state-message--error">Failed to load General Meeting.</p>;
  }

  /* c8 ignore next -- unreachable: error handling above covers all falsy data cases */
  if (!meeting) return <p className="state-message">General Meeting not found</p>;

  const meetingExtended = meeting as GeneralMeetingDetail & {
    email_delivery?: { status: string; last_error: string | null };
  };

  const showEmailBanner =
    meeting.status === "closed" &&
    meetingExtended.email_delivery?.status === "failed";

  return (
    <div>
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/admin/general-meetings")}>
        ← Back
      </button>
      <div className="admin-page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0 }}>{meeting.title}</h1>
          <StatusBadge status={meeting.status} />
        </div>
        {meeting.status === "pending" && (
          <StartGeneralMeetingButton
            meetingId={meetingId!}
            onSuccess={handleCloseSuccess}
          />
        )}
        {meeting.status === "open" && (
          <CloseGeneralMeetingButton
            meetingId={meetingId!}
            meetingTitle={meeting.title}
            onSuccess={handleCloseSuccess}
          />
        )}
      </div>

      <div className="admin-meta">
        <span className="admin-meta__item">
          <span className="admin-meta__label">Building</span>
          {meeting.building_name}
        </span>
        <span className="admin-meta__item">
          <span className="admin-meta__label">Meeting</span>
          {new Date(meeting.meeting_at).toLocaleString()}
        </span>
        <span className="admin-meta__item">
          <span className="admin-meta__label">Voting closes</span>
          {new Date(meeting.voting_closes_at).toLocaleString()}
        </span>
        {meeting.closed_at && (
          <span className="admin-meta__item">
            <span className="admin-meta__label">Closed at</span>
            {new Date(meeting.closed_at).toLocaleString()}
          </span>
        )}
        <span className="admin-meta__item">
          <span className="admin-meta__label">Summary</span>
          <ShareSummaryLink meetingId={meetingId!} />
        </span>
      </div>

      <div className="admin-stats">
        <div className="admin-stats__item">
          <span className="admin-stats__label">Eligible voters</span>
          <span className="admin-stats__value">{meeting.total_eligible_voters}</span>
        </div>
        <div className="admin-stats__item">
          <span className="admin-stats__label">Submitted</span>
          <span className="admin-stats__value">{meeting.total_submitted}</span>
        </div>
        <div className="admin-stats__item">
          <span className="admin-stats__label">Participation</span>
          <span className="admin-stats__value">
            {meeting.total_eligible_voters > 0
              ? Math.round((meeting.total_submitted / meeting.total_eligible_voters) * 100)
              : 0}%
          </span>
        </div>
      </div>

      {showEmailBanner && (
        <EmailStatusBanner
          meetingId={meetingId!}
          lastError={meetingExtended.email_delivery?.last_error ?? null}
          onRetrySuccess={handleRetrySuccess}
        />
      )}

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Results Report</h2>
      <AGMReportView motions={meeting.motions} agmTitle={meeting.title} totalEntitlement={meeting.total_entitlement} />
    </div>
  );
}
