import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getGeneralMeetingDetail,
  deleteGeneralMeeting,
  toggleMotionVisibility,
  addMotionToMeeting,
  updateMotion,
  deleteMotion,
} from "../../api/admin";
import type { GeneralMeetingDetail, AddMotionRequest, UpdateMotionRequest } from "../../api/admin";
import type { MotionType } from "../../types";
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
  const [motionsWithVotes, setMotionsWithVotes] = useState<Set<string>>(new Set());

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

  // Add motion state
  const [showAddMotionForm, setShowAddMotionForm] = useState(false);
  const [addMotionForm, setAddMotionForm] = useState<{ title: string; description: string; motion_type: MotionType }>({
    title: "",
    description: "",
    motion_type: "general",
  });
  const [addMotionError, setAddMotionError] = useState<string | null>(null);

  // Edit motion state
  const [editingMotionId, setEditingMotionId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ title: string; description: string; motion_type: MotionType }>({
    title: "",
    description: "",
    motion_type: "general",
  });
  const [editMotionError, setEditMotionError] = useState<string | null>(null);

  // Delete motion error state (per motion)
  const [deleteMotionErrors, setDeleteMotionErrors] = useState<Record<string, string>>({});

  const addMotionMutation = useMutation({
    mutationFn: (data: AddMotionRequest) => addMotionToMeeting(meetingId!, data),
    onSuccess: () => {
      setShowAddMotionForm(false);
      setAddMotionError(null);
      setAddMotionForm({ title: "", description: "", motion_type: "general" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error) => {
      setAddMotionError(error.message || "Failed to add motion");
    },
  });

  const updateMotionMutation = useMutation({
    mutationFn: ({ motionId, data }: { motionId: string; data: UpdateMotionRequest }) =>
      updateMotion(motionId, data),
    onSuccess: () => {
      setEditingMotionId(null);
      setEditMotionError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error) => {
      setEditMotionError(error.message || "Failed to update motion");
    },
  });

  const deleteMotionMutation = useMutation({
    mutationFn: (motionId: string) => deleteMotion(motionId),
    onSuccess: (_data, motionId) => {
      setDeleteMotionErrors((prev) => {
        const next = { ...prev };
        delete next[motionId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error, motionId) => {
      setDeleteMotionErrors((prev) => ({ ...prev, [motionId]: error.message || "Failed to delete motion" }));
    },
  });

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
      const isVotesError = error.message.includes("received votes");
      if (isVotesError) {
        setMotionsWithVotes((prev) => new Set([...prev, variables.motionId]));
      }
      const msg = isVotesError
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
      <div style={{ marginBottom: 24 }}>
        {meeting.status !== "closed" && (
          <div style={{ marginBottom: 12 }}>
            {!showAddMotionForm ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => { setShowAddMotionForm(true); setAddMotionError(null); }}
              >
                Add Motion
              </button>
            ) : (
              <div className="admin-card" style={{ marginBottom: 16 }}>
                <h3 className="admin-card__title">Add Motion</h3>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!addMotionForm.title.trim()) {
                      setAddMotionError("Title is required");
                      return;
                    }
                    addMotionMutation.mutate({
                      title: addMotionForm.title,
                      description: addMotionForm.description || null,
                      motion_type: addMotionForm.motion_type,
                    });
                  }}
                >
                  <div className="field">
                    <label className="field__label" htmlFor="add-motion-title">Title *</label>
                    <input
                      id="add-motion-title"
                      className="field__input"
                      value={addMotionForm.title}
                      onChange={(e) => setAddMotionForm((f) => ({ ...f, title: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="add-motion-description">Description</label>
                    <textarea
                      id="add-motion-description"
                      className="field__input"
                      value={addMotionForm.description}
                      onChange={(e) => setAddMotionForm((f) => ({ ...f, description: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="add-motion-type">Motion Type</label>
                    <select
                      id="add-motion-type"
                      className="field__select"
                      value={addMotionForm.motion_type}
                      onChange={(e) => setAddMotionForm((f) => ({ ...f, motion_type: e.target.value as MotionType }))}
                    >
                      <option value="general">General</option>
                      <option value="special">Special</option>
                    </select>
                  </div>
                  {addMotionError && (
                    <span role="alert" className="field__error">
                      {addMotionError}
                    </span>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={addMotionMutation.isPending}
                    >
                      {addMotionMutation.isPending ? "Saving…" : "Save Motion"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => { setShowAddMotionForm(false); setAddMotionError(null); }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
        {meeting.motions.length === 0 ? (
          <p className="state-message">No motions.</p>
        ) : (
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Motion</th>
                  <th>Type</th>
                  <th>Visibility</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {meeting.motions.map((motion) => {
                  const isVisLoading = pendingVisibilityMotionId === motion.id;
                  const isVisDisabled =
                    meeting.status === "closed" ||
                    motionsWithVotes.has(motion.id) ||
                    isVisLoading;
                  const disabledReason =
                    meeting.status === "closed"
                      ? "Meeting is closed"
                      : motionsWithVotes.has(motion.id)
                      ? "Motion has received votes"
                      : undefined;
                  const isEditDeleteDisabled = motion.is_visible || meeting.status === "closed";
                  const editDeleteTitle = isEditDeleteDisabled ? "Hide this motion first to edit or delete" : undefined;
                  return (
                    <>
                      <tr
                        key={motion.id}
                        className={!motion.is_visible ? "admin-table__row--muted" : undefined}
                      >
                        <td style={{ fontFamily: "'Overpass Mono', monospace", color: "var(--text-muted)" }}>
                          {motion.order_index + 1}
                        </td>
                        <td>
                          <span style={{ fontWeight: 500 }}>{motion.title}</span>
                          {motion.description && (
                            <p style={{ margin: "2px 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                              {motion.description}
                            </p>
                          )}
                        </td>
                        <td>
                          <span
                            className={`motion-type-badge motion-type-badge--${motion.motion_type}`}
                            aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
                          >
                            {motion.motion_type === "special" ? "Special" : "General"}
                          </span>
                        </td>
                        <td>
                          <label
                            className={`motion-visibility-toggle${isVisDisabled ? " motion-visibility-toggle--disabled" : ""}${isVisLoading ? " motion-visibility-toggle--loading" : ""}`}
                            title={disabledReason}
                          >
                            <input
                              type="checkbox"
                              className="motion-visibility-toggle__input"
                              checked={motion.is_visible}
                              disabled={isVisDisabled}
                              onChange={() => {
                                setVisibilityErrors((prev) => {
                                  const next = { ...prev };
                                  delete next[motion.id];
                                  return next;
                                });
                                visibilityMutation.mutate({ motionId: motion.id, isVisible: !motion.is_visible });
                              }}
                            />
                            <span className="motion-visibility-toggle__track" />
                            <span className="motion-visibility-toggle__label">
                              {motion.is_visible ? "Visible" : "Hidden"}
                            </span>
                          </label>
                          {visibilityErrors[motion.id] && (
                            <span style={{ display: "block", color: "var(--red)", fontSize: "0.875rem", marginTop: 4 }} role="alert">
                              {visibilityErrors[motion.id]}
                            </span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn--table-edit btn--sm"
                              disabled={isEditDeleteDisabled}
                              title={editDeleteTitle}
                              onClick={() => {
                                setEditingMotionId(motion.id);
                                setEditForm({
                                  title: motion.title,
                                  description: motion.description ?? "",
                                  motion_type: motion.motion_type,
                                });
                                setEditMotionError(null);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--table-delete btn--sm"
                              disabled={isEditDeleteDisabled}
                              title={editDeleteTitle}
                              onClick={() => {
                                if (window.confirm("Delete this motion? This cannot be undone.")) {
                                  deleteMotionMutation.mutate(motion.id);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                          {deleteMotionErrors[motion.id] && (
                            <span style={{ display: "block", color: "var(--red)", fontSize: "0.875rem", marginTop: 4 }} role="alert">
                              {deleteMotionErrors[motion.id]}
                            </span>
                          )}
                        </td>
                      </tr>
                      {editingMotionId === motion.id && (
                        <tr key={`edit-${motion.id}`}>
                          <td colSpan={5}>
                            <div className="admin-card" style={{ margin: "8px 0" }}>
                              <h4 className="admin-card__title">Edit Motion</h4>
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  updateMotionMutation.mutate({
                                    motionId: motion.id,
                                    data: {
                                      title: editForm.title || undefined,
                                      description: editForm.description || undefined,
                                      motion_type: editForm.motion_type,
                                    },
                                  });
                                }}
                              >
                                <div className="field">
                                  <label className="field__label" htmlFor={`edit-title-${motion.id}`}>Title</label>
                                  <input
                                    id={`edit-title-${motion.id}`}
                                    className="field__input"
                                    aria-label="Edit Title"
                                    value={editForm.title}
                                    onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                                  />
                                </div>
                                <div className="field">
                                  <label className="field__label" htmlFor={`edit-desc-${motion.id}`}>Description</label>
                                  <textarea
                                    id={`edit-desc-${motion.id}`}
                                    className="field__input"
                                    aria-label="Edit Description"
                                    value={editForm.description}
                                    onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                                  />
                                </div>
                                <div className="field">
                                  <label className="field__label" htmlFor={`edit-type-${motion.id}`}>Motion Type</label>
                                  <select
                                    id={`edit-type-${motion.id}`}
                                    className="field__select"
                                    aria-label="Edit Motion Type"
                                    value={editForm.motion_type}
                                    onChange={(e) => setEditForm((f) => ({ ...f, motion_type: e.target.value as MotionType }))}
                                  >
                                    <option value="general">General</option>
                                    <option value="special">Special</option>
                                  </select>
                                </div>
                                {editMotionError && (
                                  <span role="alert" className="field__error">
                                    {editMotionError}
                                  </span>
                                )}
                                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                                  <button
                                    type="submit"
                                    className="btn btn--primary"
                                    disabled={updateMotionMutation.isPending}
                                  >
                                    {updateMotionMutation.isPending ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--secondary"
                                    onClick={() => setEditingMotionId(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </form>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Results Report</h2>
      <AGMReportView motions={meeting.motions} agmTitle={meeting.title} totalEntitlement={meeting.total_entitlement} />
    </div>
  );
}
