import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getGeneralMeetingDetail, deleteGeneralMeeting, toggleMotionVisibility } from "../../api/admin";
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
  const [visibilityErrors, setVisibilityErrors] = useState<Record<string, string>>({});

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

  const deleteMutation = useMutation({
    mutationFn: () => deleteGeneralMeeting(meetingId!),
    onSuccess: () => {
      navigate("/admin/general-meetings");
    },
  });

  const [pendingVisibilityMotionId, setPendingVisibilityMotionId] = useState<string | null>(null);

  const visibilityMutation = useMutation({
    mutationFn: ({ motionId, isVisible }: { motionId: string; isVisible: boolean }) => {
      setPendingVisibilityMotionId(motionId);
      return toggleMotionVisibility(motionId, isVisible);
    },
    onSuccess: () => {
      setPendingVisibilityMotionId(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error, variables) => {
      setPendingVisibilityMotionId(null);
      const msg = error.message.includes("409")
        ? "Cannot hide: motion has received votes"
        : error.message.includes("Cannot change visibility on a closed meeting")
        ? "Cannot change visibility on a closed meeting"
        : "Failed to update visibility";
      setVisibilityErrors((prev) => ({ ...prev, [variables.motionId]: msg }));
    },
  });

  function handleDelete() {
    if (window.confirm("Delete this meeting? This cannot be undone.")) {
      deleteMutation.mutate();
    }
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
        {(meeting.status === "closed" || meeting.status === "pending") && (
          <button
            type="button"
            className="btn btn--danger"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            Delete Meeting
          </button>
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
          <span className="admin-meta__label">Voting link</span>
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

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Motion Visibility</h2>
      <div className="admin-card" style={{ marginBottom: 24 }}>
        {meeting.motions.length === 0 ? (
          <p className="state-message">No motions.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {meeting.motions.map((motion) => (
              <li key={motion.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ flex: 1 }}>
                  <strong>{motion.order_index + 1}. {motion.title}</strong>
                  <span
                    className={`motion-type-badge${motion.motion_type === "special" ? " motion-type-badge--special" : " motion-type-badge--general"}`}
                    style={{ marginLeft: 8 }}
                  >
                    {motion.motion_type === "special" ? "Special" : "General"}
                  </span>
                  {!motion.is_visible && (
                    <span className="motion-type-badge motion-type-badge--hidden" style={{ marginLeft: 8 }} aria-label="Hidden">
                      Hidden
                    </span>
                  )}
                </span>
                {visibilityErrors[motion.id] && (
                  <span style={{ color: "var(--red)", fontSize: "0.875rem" }} role="alert">
                    {visibilityErrors[motion.id]}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn--secondary"
                  aria-label={motion.is_visible ? `Hide motion ${motion.order_index + 1}` : `Show motion ${motion.order_index + 1}`}
                  disabled={meeting.status === "closed" || pendingVisibilityMotionId === motion.id}
                  onClick={() => {
                    setVisibilityErrors((prev) => { const next = { ...prev }; delete next[motion.id]; return next; });
                    visibilityMutation.mutate({ motionId: motion.id, isVisible: !motion.is_visible });
                  }}
                >
                  {pendingVisibilityMotionId === motion.id
                    ? "..."
                    : motion.is_visible
                    ? "Hide"
                    : "Show"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Results Report</h2>
      <AGMReportView motions={meeting.motions} agmTitle={meeting.title} totalEntitlement={meeting.total_entitlement} />
    </div>
  );
}
