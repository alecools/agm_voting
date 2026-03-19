import { useState, useEffect } from "react";
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
import type { GeneralMeetingDetail, AddMotionRequest, UpdateMotionRequest, MotionDetail } from "../../api/admin";
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
  const [isBulkLoading, setIsBulkLoading] = useState(false);

  // Add motion state
  const [showAddMotionModal, setShowAddMotionModal] = useState(false);
  const [addMotionForm, setAddMotionForm] = useState<{ title: string; description: string; motion_type: MotionType }>({
    title: "",
    description: "",
    motion_type: "general",
  });
  const [addMotionError, setAddMotionError] = useState<string | null>(null);

  // Edit motion state
  const [editingMotion, setEditingMotion] = useState<MotionDetail | null>(null);
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
      setShowAddMotionModal(false);
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
      setEditingMotion(null);
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

  // Escape key handler for edit modal
  useEffect(() => {
    if (!editingMotion) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !updateMotionMutation.isPending) {
        setEditingMotion(null);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editingMotion, updateMotionMutation.isPending]);

  // Escape key handler for add motion modal
  useEffect(() => {
    if (!showAddMotionModal) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setShowAddMotionModal(false); setAddMotionError(null); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [showAddMotionModal]);

  async function handleShowAll() {
    const hidden = meeting!.motions.filter((m) => !m.is_visible);
    if (hidden.length === 0) return;
    setIsBulkLoading(true);
    try {
      await Promise.all(hidden.map((m) => toggleMotionVisibility(m.id, true)));
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    } finally {
      setIsBulkLoading(false);
    }
  }

  async function handleHideAll() {
    const visible = meeting!.motions.filter((m) => m.is_visible);
    if (visible.length === 0) return;
    setIsBulkLoading(true);
    try {
      await Promise.allSettled(
        visible.map((m) =>
          toggleMotionVisibility(m.id, false).catch((err: Error) => {
            // Silently skip motions that have received votes (409)
            if (!err.message.includes("received votes")) throw err;
          })
        )
      );
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    } finally {
      setIsBulkLoading(false);
    }
  }

  function handleDelete() {
    if (window.confirm("Delete this meeting? This cannot be undone.")) {
      deleteMutation.mutate();
    }
  }

  function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingMotion) return;
    updateMotionMutation.mutate({
      motionId: editingMotion.id,
      data: {
        title: editForm.title || undefined,
        description: editForm.description || undefined,
        motion_type: editForm.motion_type,
      },
    });
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
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => { setShowAddMotionModal(true); setAddMotionError(null); }}
            >
              Add Motion
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={isBulkLoading || meeting.motions.every((m) => m.is_visible)}
              onClick={() => void handleShowAll()}
            >
              {isBulkLoading ? "Working…" : "Show All"}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={isBulkLoading || meeting.motions.every((m) => !m.is_visible) || meeting.motions.filter((m) => m.is_visible).length === 0}
              onClick={() => void handleHideAll()}
            >
              {isBulkLoading ? "Working…" : "Hide All"}
            </button>
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
                    isVisLoading ||
                    isBulkLoading;
                  const disabledReason =
                    meeting.status === "closed"
                      ? "Meeting is closed"
                      : motionsWithVotes.has(motion.id)
                      ? "Motion has received votes"
                      : undefined;
                  const isEditDeleteDisabled = motion.is_visible || meeting.status === "closed";
                  const editDeleteTitle = isEditDeleteDisabled ? "Hide this motion first to edit or delete" : undefined;
                  const mutedCell = !motion.is_visible ? "admin-table__cell--muted" : undefined;
                  return (
                    <tr
                      key={motion.id}
                    >
                      <td
                        className={mutedCell}
                        style={{ fontFamily: "'Overpass Mono', monospace", color: "var(--text-muted)" }}
                      >
                        {motion.order_index + 1}
                      </td>
                      <td className={mutedCell}>
                        <span style={{ fontWeight: 500 }}>{motion.title}</span>
                        {motion.description && (
                          <p style={{ margin: "2px 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                            {motion.description}
                          </p>
                        )}
                      </td>
                      <td className={mutedCell}>
                        <span
                          className={`motion-type-badge motion-type-badge--${motion.motion_type}`}
                          aria-label={`Motion type: ${motion.motion_type === "special" ? "Special" : "General"}`}
                        >
                          {motion.motion_type === "special" ? "Special" : "General"}
                        </span>
                      </td>
                      <td className={mutedCell}>
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
                            className="btn btn--secondary"
                            style={{ padding: "5px 14px", fontSize: "0.8rem" }}
                            disabled={isEditDeleteDisabled}
                            title={editDeleteTitle}
                            onClick={() => {
                              setEditingMotion(motion);
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
                            className="btn btn--danger btn--sm"
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Results Report</h2>
      <AGMReportView motions={meeting.motions} agmTitle={meeting.title} totalEntitlement={meeting.total_entitlement} />

      {/* Add Motion Modal */}
      {showAddMotionModal && (
        <>
          {/* Backdrop */}
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200 }}
            onClick={() => { setShowAddMotionModal(false); setAddMotionError(null); }}
          />
          {/* Panel */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Add Motion"
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(480px, 90vw)",
              zIndex: 201,
              background: "white",
              borderRadius: "var(--r-lg)",
              padding: "1.5rem",
              boxShadow: "var(--shadow-lg)",
            }}
          >
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
                  onClick={() => { setShowAddMotionModal(false); setAddMotionError(null); }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* Edit Motion Modal */}
      {editingMotion && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit Motion"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditingMotion(null); }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "var(--r-lg)",
              padding: 32,
              minWidth: 360,
              maxWidth: 480,
              width: "100%",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 20 }}>Edit Motion</h2>
            <form onSubmit={handleEditSubmit}>
              <div className="field">
                <label className="field__label" htmlFor="modal-edit-title">Title</label>
                <input
                  id="modal-edit-title"
                  className="field__input"
                  type="text"
                  required
                  value={editForm.title}
                  onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="modal-edit-description">Description</label>
                <textarea
                  id="modal-edit-description"
                  className="field__input"
                  value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="modal-edit-type">Motion Type</label>
                <select
                  id="modal-edit-type"
                  className="field__select"
                  value={editForm.motion_type}
                  onChange={(e) => setEditForm((f) => ({ ...f, motion_type: e.target.value as MotionType }))}
                >
                  <option value="general">General</option>
                  <option value="special_resolution">Special Resolution</option>
                </select>
              </div>
              {editMotionError && (
                <span role="alert" className="field__error">{editMotionError}</span>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setEditingMotion(null)}
                  disabled={updateMotionMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={updateMotionMutation.isPending}
                >
                  {updateMotionMutation.isPending ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
