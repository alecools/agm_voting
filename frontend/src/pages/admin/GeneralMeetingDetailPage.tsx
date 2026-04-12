import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getGeneralMeetingDetail,
  deleteGeneralMeeting,
  reorderMotions,
  toggleMotionVisibility,
  addMotionToMeeting,
  updateMotion,
  deleteMotion,
  resendReport,
  closeMotion,
} from "../../api/admin";
import type { GeneralMeetingDetail, AddMotionRequest, UpdateMotionRequest, MotionDetail } from "../../api/admin";
import type { MotionType } from "../../types";
import StatusBadge from "../../components/admin/StatusBadge";
import CloseGeneralMeetingButton from "../../components/admin/CloseGeneralMeetingButton";
import StartGeneralMeetingButton from "../../components/admin/StartGeneralMeetingButton";
import EmailStatusBanner from "../../components/admin/EmailStatusBanner";
import AGMReportView from "../../components/admin/AGMReportView";
import ShareSummaryLink from "../../components/admin/ShareSummaryLink";
import MotionManagementTable from "../../components/admin/MotionManagementTable";
import AdminVoteEntryPanel from "./AdminVoteEntryPanel";
import { formatLocalDateTime } from "../../utils/dateTime";
import { useBranding } from "../../context/BrandingContext";

const AgmQrCode = lazy(() => import("../../components/admin/AgmQrCode"));
const AgmQrCodeModal = lazy(() => import("../../components/admin/AgmQrCodeModal"));

interface DeleteMeetingConfirmModalProps {
  meetingTitle: string;
  deleting: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

interface DeleteMotionConfirmModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteMotionConfirmModal({ onConfirm, onCancel }: DeleteMotionConfirmModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete Motion"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 16 }}>Delete this motion?</h2>
        <p style={{ marginBottom: 24, color: "var(--text-secondary)" }}>
          This cannot be undone.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteMeetingConfirmModal({ meetingTitle, deleting, error, onConfirm, onCancel }: DeleteMeetingConfirmModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !deleting) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleting, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete Meeting"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !deleting) onCancel(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 16 }}>Delete "{meetingTitle}"?</h2>
        <p style={{ marginBottom: 24, color: "var(--text-secondary)" }}>
          This action cannot be undone. All motions, votes, and ballot submissions for this meeting will be permanently deleted.
        </p>
        {error && (
          <p role="alert" style={{ color: "var(--red)", background: "var(--red-bg)", borderRadius: "var(--r-md)", padding: "10px 14px", marginBottom: 16 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete Meeting"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Fix 9: modal dialog to replace the green banner after in-person vote submission
function VoteEntrySuccessModal({ onClose }: { onClose: () => void }) {
  const handleClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vest-success-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        style={{
          background: "var(--white)",
          borderRadius: "var(--r-lg)",
          padding: 32,
          minWidth: 360,
          maxWidth: 480,
          width: "100%",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 id="vest-success-title" style={{ marginTop: 0, marginBottom: 12 }}>
          Votes submitted
        </h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: 24 }}>
          In-person votes have been recorded successfully.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--primary" onClick={handleClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export default function GeneralMeetingDetailPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { effectiveFaviconUrl } = useBranding();
  // Fix 10: per-motion drill-down — no global collapse needed
  const [visibilityErrors, setVisibilityErrors] = useState<Record<string, string>>({});
  const [motionsWithVotes, setMotionsWithVotes] = useState<Set<string>>(new Set());
  const [showDeleteMeetingModal, setShowDeleteMeetingModal] = useState(false);
  const [deleteMeetingError, setDeleteMeetingError] = useState<string | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);

  // Optimistic motions list — updated immediately on reorder, confirmed on API response
  const [optimisticMotions, setOptimisticMotions] = useState<MotionDetail[] | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const { data: meeting, isLoading, error } = useQuery<GeneralMeetingDetail>({
    queryKey: ["admin", "general-meetings", meetingId],
    queryFn: () => getGeneralMeetingDetail(meetingId!),
    enabled: !!meetingId,
  });

  // Reset optimistic state whenever fresh data arrives
  if (meeting && optimisticMotions !== null) {
    const serverIds = meeting.motions.map((m) => m.id).join(",");
    const optimisticIds = optimisticMotions.map((m) => m.id).join(",");
    if (serverIds === optimisticIds) {
      // Server confirmed our optimistic order — clear it so we use server data
      setOptimisticMotions(null);
    }
  }

  const reorderMutation = useMutation({
    mutationFn: (newOrder: MotionDetail[]) => {
      const items = newOrder.map((m, idx) => ({
        motion_id: m.id,
        display_order: idx + 1,
      }));
      return reorderMotions(meetingId!, items);
    },
    onSuccess: (result) => {
      // Build updated meeting with new motion order
      queryClient.setQueryData(
        ["admin", "general-meetings", meetingId],
        (old: GeneralMeetingDetail | undefined) => {
          if (!old) return old;
          // Merge new display_order values into existing motion objects
          const orderMap = new Map(result.motions.map((m) => [m.id, m.display_order]));
          const merged = [...old.motions]
            .map((m) => ({ ...m, display_order: orderMap.get(m.id) ?? m.display_order }))
            .sort((a, b) => a.display_order - b.display_order);
          return { ...old, motions: merged };
        }
      );
      setOptimisticMotions(null);
      setReorderError(null);
    },
    onError: (err: Error, _previousOrder) => {
      // Revert optimistic update
      if (meeting) {
        setOptimisticMotions(meeting.motions);
        /* c8 ignore next 3 -- meeting is always defined when reorder is triggered from the UI; else branch unreachable in practice */
      } else {
        setOptimisticMotions(null);
      }
      setReorderError(err.message ?? "Failed to reorder motions");
    },
  });

  function handleReorder(newOrder: MotionDetail[]) {
    setReorderError(null);
    setOptimisticMotions(newOrder);
    reorderMutation.mutate(newOrder);
  }

  function handleCloseSuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  }

  function handleRetrySuccess() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  }

  const deleteMutation = useMutation({
    mutationFn: () => deleteGeneralMeeting(meetingId!),
    onSuccess: async () => {
      navigate("/admin/general-meetings");
    },
    onError: (err: Error) => {
      // Extract the detail message from the raw "HTTP 4xx: {...}" error string
      let msg = err.message || "Failed to delete meeting";
      const jsonStart = msg.indexOf("{");
      if (jsonStart !== -1) {
        try {
          const parsed = JSON.parse(msg.slice(jsonStart)) as { detail?: string };
          if (parsed.detail) msg = parsed.detail;
        } catch {
          // leave msg as-is if JSON parse fails
        }
      }
      setDeleteMeetingError(msg);
    },
  });

  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const resendMutation = useMutation({
    mutationFn: () => resendReport(meetingId!),
    onSuccess: async () => {
      setResendSuccess(true);
      setResendError(null);
    },
    onError: (err: Error) => {
      setResendError(err.message || "Failed to resend summary email");
      setResendSuccess(false);
    },
  });

  const [pendingVisibilityMotionId, setPendingVisibilityMotionId] = useState<string | null>(null);
  const [isBulkLoading, setIsBulkLoading] = useState(false);

  // Add motion state
  const [showAddMotionModal, setShowAddMotionModal] = useState(false);
  const [addMotionForm, setAddMotionForm] = useState<{ title: string; description: string; motion_type: MotionType; is_multi_choice: boolean; motion_number: string; option_limit: string; options: Array<{ text: string }> }>({
    title: "",
    description: "",
    motion_type: "general",
    is_multi_choice: false,
    motion_number: "",
    option_limit: "1",
    options: [{ text: "" }, { text: "" }],
  });
  const [addMotionError, setAddMotionError] = useState<string | null>(null);

  // Edit motion state
  const [editingMotion, setEditingMotion] = useState<MotionDetail | null>(null);
  const [editForm, setEditForm] = useState<{ title: string; description: string; motion_type: MotionType; is_multi_choice: boolean; motion_number: string; option_limit: string; options: Array<{ text: string }> }>({
    title: "",
    description: "",
    motion_type: "general",
    is_multi_choice: false,
    motion_number: "",
    option_limit: "1",
    options: [{ text: "" }, { text: "" }],
  });
  const [editMotionError, setEditMotionError] = useState<string | null>(null);

  // Delete motion error state (per motion)
  const [deleteMotionErrors, setDeleteMotionErrors] = useState<Record<string, string>>({});

  // Delete motion confirmation state
  const [pendingDeleteMotionId, setPendingDeleteMotionId] = useState<string | null>(null);

  // Admin vote entry panel
  const [showVoteEntryPanel, setShowVoteEntryPanel] = useState(false);
  // Fix 9: modal replaces the old green banner
  const [showVoteEntrySuccessModal, setShowVoteEntrySuccessModal] = useState(false);

  const addMotionMutation = useMutation({
    mutationFn: (data: AddMotionRequest) => addMotionToMeeting(meetingId!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
      setShowAddMotionModal(false);
      setAddMotionError(null);
      setAddMotionForm({ title: "", description: "", motion_type: "general", is_multi_choice: false, motion_number: "", option_limit: "1", options: [{ text: "" }, { text: "" }] });
    },
    onError: (error: Error) => {
      setAddMotionError(error.message || "Failed to add motion");
    },
  });

  const updateMotionMutation = useMutation({
    mutationFn: ({ motionId, data }: { motionId: string; data: UpdateMotionRequest }) =>
      updateMotion(motionId, data),
    onSuccess: async () => {
      setEditingMotion(null);
      setEditMotionError(null);
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error) => {
      setEditMotionError(error.message || "Failed to update motion");
    },
  });

  const deleteMotionMutation = useMutation({
    mutationFn: (motionId: string) => deleteMotion(motionId),
    onSuccess: async (_data, motionId) => {
      setDeleteMotionErrors((prev) => {
        const next = { ...prev };
        delete next[motionId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error, motionId) => {
      setDeleteMotionErrors((prev) => ({ ...prev, [motionId]: error.message || "Failed to delete motion" }));
    },
  });

  // Close Motion state
  const [closeMotionErrors, setCloseMotionErrors] = useState<Record<string, string>>({});
  const [pendingCloseMotionId, setPendingCloseMotionId] = useState<string | null>(null);
  const [pendingCloseMotionConfirmId, setPendingCloseMotionConfirmId] = useState<string | null>(null);

  const closeMotionMutation = useMutation({
    mutationFn: (motionId: string) => {
      setPendingCloseMotionId(motionId);
      return closeMotion(motionId);
    },
    onSuccess: async (_data, motionId) => {
      setPendingCloseMotionId(null);
      setCloseMotionErrors((prev) => {
        const next = { ...prev };
        delete next[motionId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
    },
    onError: (error: Error, motionId) => {
      setPendingCloseMotionId(null);
      setCloseMotionErrors((prev) => ({ ...prev, [motionId]: error.message || "Failed to close motion" }));
    },
  });

  const visibilityMutation = useMutation({
    mutationFn: ({ motionId, isVisible }: { motionId: string; isVisible: boolean }) => {
      setPendingVisibilityMotionId(motionId);
      return toggleMotionVisibility(motionId, isVisible);
    },
    onMutate: async ({ motionId, isVisible }) => {
      await queryClient.cancelQueries({ queryKey: ["admin", "general-meetings", meetingId] });
      const previous = queryClient.getQueryData(["admin", "general-meetings", meetingId]);
      queryClient.setQueryData(["admin", "general-meetings", meetingId], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          motions: old.motions.map((m: any) =>
            m.id === motionId ? { ...m, is_visible: isVisible } : m
          ),
        };
      });
      return { previous };
    },
    onError: (error: Error, variables, context: any) => {
      if (context?.previous) {
        queryClient.setQueryData(["admin", "general-meetings", meetingId], context.previous);
      }
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
    onSuccess: async () => {
      setPendingVisibilityMotionId(null);
      await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
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
    setDeleteMeetingError(null);
    setShowDeleteMeetingModal(true);
  }

  function handleDeleteMeetingConfirm() {
    deleteMutation.mutate();
  }

  function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingMotion) return;

    // Validate multi-choice fields
    if (editForm.is_multi_choice) {
      const validOptions = editForm.options.filter((o) => o.text.trim());
      if (validOptions.length < 2) {
        setEditMotionError("Multi-choice motions require at least 2 options.");
        return;
      }
      const limit = parseInt(editForm.option_limit, 10);
      if (isNaN(limit) || limit < 1) {
        setEditMotionError("Option limit must be at least 1.");
        return;
      }
      if (limit > validOptions.length) {
        setEditMotionError("Option limit cannot exceed the number of options.");
        return;
      }
    }

    updateMotionMutation.mutate({
      motionId: editingMotion.id,
      data: {
        title: editForm.title || undefined,
        description: editForm.description || undefined,
        motion_type: editForm.motion_type,
        is_multi_choice: editForm.is_multi_choice,
        // Send trimmed string (possibly empty ""); empty string is handled by
        // the backend as "clear the motion number" (sets motion_number = null).
        // We must NOT send null here because the backend skips the field when
        // motion_number is null (partial-update semantics).
        motion_number: editForm.motion_number.trim(),
        ...(editForm.is_multi_choice ? {
          option_limit: parseInt(editForm.option_limit, 10),
          options: editForm.options
            .filter((o) => o.text.trim())
            .map((o, idx) => ({ text: o.text.trim(), display_order: idx + 1 })),
        } : {}),
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

  const showEmailBanner =
    meeting.status === "closed" &&
    meeting.email_delivery?.status === "failed";

  // Use optimistic motions for the reorder panel; fall back to server data
  const displayMotions = optimisticMotions ?? meeting.motions;

  return (
    <div>
      {showVoteEntryPanel && (
        <AdminVoteEntryPanel
          meeting={meeting}
          onClose={() => setShowVoteEntryPanel(false)}
          onSuccess={async () => {
            setShowVoteEntryPanel(false);
            setShowVoteEntrySuccessModal(true);
            await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
          }}
        />
      )}
      {/* Fix 9: success modal replaces the old green banner */}
      {showVoteEntrySuccessModal && (
        <VoteEntrySuccessModal onClose={() => setShowVoteEntrySuccessModal(false)} />
      )}
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

      <div className="meeting-detail-layout">
        <div className="meeting-detail-layout__info">
          <div className="admin-meta">
            <span className="admin-meta__item">
              <span className="admin-meta__label">Building</span>
              {meeting.building_name}
            </span>
            <span className="admin-meta__item">
              <span className="admin-meta__label">Meeting</span>
              {formatLocalDateTime(meeting.meeting_at)}
            </span>
            <span className="admin-meta__item">
              <span className="admin-meta__label">Voting closes</span>
              {formatLocalDateTime(meeting.voting_closes_at)}
            </span>
            {meeting.closed_at && (
              <span className="admin-meta__item">
                <span className="admin-meta__label">Closed at</span>
                {formatLocalDateTime(meeting.closed_at)}
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
        </div>

        <div className="meeting-detail-layout__qr">
          <Suspense fallback={null}>
            <button
              type="button"
              aria-label="Show QR code"
              className="meeting-detail-layout__qr-btn"
              onClick={() => setShowQrModal(true)}
            >
              <AgmQrCode agmId={meetingId!} faviconUrl={effectiveFaviconUrl} size={160} />
            </button>
          </Suspense>
        </div>
      </div>

      {showEmailBanner && (
        <EmailStatusBanner
          meetingId={meetingId!}
          lastError={meeting.email_delivery?.last_error ?? null}
          onRetrySuccess={handleRetrySuccess}
        />
      )}

      {meeting.status === "closed" && meeting.email_delivery && !showEmailBanner && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => { setResendSuccess(false); setResendError(null); resendMutation.mutate(); }}
            disabled={resendMutation.isPending}
          >
            {resendMutation.isPending ? "Sending..." : "Resend Summary Email"}
          </button>
          {resendSuccess && (
            <span style={{ color: "var(--green)", fontSize: "0.875rem", fontWeight: 600 }}>
              Summary email queued for resend.
            </span>
          )}
          {resendError && (
            <span role="alert" style={{ color: "var(--red)", fontSize: "0.875rem" }}>{resendError}</span>
          )}
        </div>
      )}

      <h2 style={{ fontSize: "1.25rem", marginBottom: 16 }}>Motions</h2>
      {meeting.status !== "closed" && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => { setShowAddMotionModal(true); setAddMotionError(null); }}
            >
              Add Motion
            </button>
            {meeting.status === "open" && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setShowVoteEntryPanel(true)}
              >
                Enter In-Person Votes
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={isBulkLoading || displayMotions.every((m) => m.is_visible)}
              onClick={() => void handleShowAll()}
            >
              {isBulkLoading ? "Working\u2026" : "Show All"}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={isBulkLoading || displayMotions.every((m) => !m.is_visible) || displayMotions.filter((m) => m.is_visible).length === 0}
              onClick={() => void handleHideAll()}
            >
              {isBulkLoading ? "Working\u2026" : "Hide All"}
            </button>
          </div>
        </div>
      )}
      {displayMotions.length === 0 ? (
        <p className="state-message">No motions.</p>
      ) : (
        <MotionManagementTable
          motions={displayMotions}
          meetingStatus={meeting.status}
          onReorder={handleReorder}
          isReorderPending={reorderMutation.isPending}
          reorderError={reorderError}
          pendingVisibilityMotionId={pendingVisibilityMotionId}
          isBulkLoading={isBulkLoading}
          motionsWithVotes={motionsWithVotes}
          visibilityErrors={visibilityErrors}
          onToggleVisibility={(motionId, isVisible) => {
            setVisibilityErrors((prev) => {
              const next = { ...prev };
              delete next[motionId];
              return next;
            });
            visibilityMutation.mutate({ motionId, isVisible });
          }}
          onEdit={(motion) => {
            setEditingMotion(motion);
            setEditForm({
              title: motion.title,
              description: motion.description ?? "",
              motion_type: motion.motion_type,
              is_multi_choice: motion.is_multi_choice ?? false,
              motion_number: motion.motion_number ?? "",
              option_limit: motion.option_limit != null ? String(motion.option_limit) : "1",
              options: motion.options && motion.options.length > 0
                ? motion.options.map((o) => ({ text: o.text }))
                : [{ text: "" }, { text: "" }],
            });
            setEditMotionError(null);
          }}
          onDelete={(motionId) => {
            setPendingDeleteMotionId(motionId);
          }}
          deleteMotionErrors={deleteMotionErrors}
          onCloseMotion={(motionId) => {
            setCloseMotionErrors((prev) => {
              const next = { ...prev };
              delete next[motionId];
              return next;
            });
            setPendingCloseMotionConfirmId(motionId);
          }}
          closeMotionErrors={closeMotionErrors}
          pendingCloseMotionId={pendingCloseMotionId}
        />
      )}


      {/* Fix 10: Results Report always visible; per-motion drill-down inside AGMReportView */}
      <div style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: 16 }}>Results Report</h2>
        <AGMReportView motions={meeting.motions} agmTitle={meeting.title} totalEntitlement={meeting.total_entitlement} />
      </div>

      {/* Close Motion Confirmation Modal */}
      {pendingCloseMotionConfirmId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Close Motion Voting"
          data-testid="close-motion-confirm-dialog"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setPendingCloseMotionConfirmId(null); }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 32,
              minWidth: 360,
              maxWidth: 480,
              width: "100%",
              boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 16 }}>Close voting for this motion?</h2>
            <p style={{ marginBottom: 24, color: "var(--text-secondary)" }}>
              Once closed, voters will no longer be able to submit votes for this motion. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setPendingCloseMotionConfirmId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                data-testid="close-motion-confirm-btn"
                onClick={() => {
                  const id = pendingCloseMotionConfirmId;
                  setPendingCloseMotionConfirmId(null);
                  closeMotionMutation.mutate(id);
                }}
              >
                Close Voting
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Motion Modal */}
      {pendingDeleteMotionId && (
        <DeleteMotionConfirmModal
          onConfirm={() => {
            deleteMotionMutation.mutate(pendingDeleteMotionId);
            setPendingDeleteMotionId(null);
          }}
          onCancel={() => setPendingDeleteMotionId(null)}
        />
      )}

      {/* Delete Meeting Modal */}
      {showDeleteMeetingModal && meeting && (
        <DeleteMeetingConfirmModal
          meetingTitle={meeting.title}
          deleting={deleteMutation.isPending}
          error={deleteMeetingError}
          onConfirm={handleDeleteMeetingConfirm}
          onCancel={() => { setShowDeleteMeetingModal(false); setDeleteMeetingError(null); }}
        />
      )}

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
                if (addMotionForm.is_multi_choice) {
                  const validOpts = addMotionForm.options.filter((o) => o.text.trim());
                  if (validOpts.length < 2) {
                    setAddMotionError("Multi-choice motions require at least 2 options.");
                    return;
                  }
                  const lim = parseInt(addMotionForm.option_limit, 10);
                  if (isNaN(lim) || lim < 1) {
                    setAddMotionError("Option limit must be at least 1.");
                    return;
                  }
                  if (lim > validOpts.length) {
                    setAddMotionError("Option limit cannot exceed the number of options.");
                    return;
                  }
                  addMotionMutation.mutate({
                    title: addMotionForm.title,
                    description: addMotionForm.description || null,
                    motion_type: addMotionForm.motion_type,
                    is_multi_choice: true,
                    motion_number: addMotionForm.motion_number.trim() || null,
                    option_limit: lim,
                    options: validOpts.map((o, idx) => ({ text: o.text.trim(), display_order: idx + 1 })),
                  });
                } else {
                  addMotionMutation.mutate({
                    title: addMotionForm.title,
                    description: addMotionForm.description || null,
                    motion_type: addMotionForm.motion_type,
                    motion_number: addMotionForm.motion_number.trim() || null,
                  });
                }
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
                <label className="field__label" htmlFor="add-motion-number">Motion number (optional)</label>
                <input
                  id="add-motion-number"
                  className="field__input"
                  type="text"
                  placeholder={`Auto (e.g. ${(meeting.motions.length + 1).toString()})`}
                  value={addMotionForm.motion_number}
                  onChange={(e) => setAddMotionForm((f) => ({ ...f, motion_number: e.target.value }))}
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
              <div className="field">
                <label className="field__label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    id="add-motion-is-multi-choice"
                    type="checkbox"
                    checked={addMotionForm.is_multi_choice}
                    onChange={(e) => setAddMotionForm((f) => ({ ...f, is_multi_choice: e.target.checked }))}
                  />
                  Multi-choice question format
                </label>
              </div>
              {addMotionForm.is_multi_choice && (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="add-option-limit">Max selections per voter</label>
                    <input
                      id="add-option-limit"
                      className="field__input"
                      type="number"
                      min={1}
                      value={addMotionForm.option_limit}
                      onChange={(e) => setAddMotionForm((f) => ({ ...f, option_limit: e.target.value }))}
                    />
                  </div>
                  <div>
                    <p className="field__label" style={{ marginBottom: 6 }}>Options (min 2)</p>
                    {addMotionForm.options.map((opt, idx) => (
                      <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                        <input
                          aria-label={`Option ${idx + 1}`}
                          className="field__input"
                          type="text"
                          value={opt.text}
                          onChange={(e) => {
                            const updated = [...addMotionForm.options];
                            updated[idx] = { text: e.target.value };
                            setAddMotionForm((f) => ({ ...f, options: updated }));
                          }}
                          placeholder={`Option ${idx + 1}`}
                        />
                        {addMotionForm.options.length > 2 && (
                          <button
                            type="button"
                            className="btn btn--danger btn--sm"
                            aria-label={`Remove option ${idx + 1}`}
                            onClick={() => {
                              const updated = addMotionForm.options.filter((_, i) => i !== idx);
                              setAddMotionForm((f) => ({ ...f, options: updated }));
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setAddMotionForm((f) => ({ ...f, options: [...f.options, { text: "" }] }))}
                    >
                      + Add option
                    </button>
                  </div>
                </>
              )}
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

      {/* QR Code Modal */}
      {showQrModal && (
        <Suspense fallback={null}>
          <AgmQrCodeModal
            agmId={meetingId!}
            faviconUrl={effectiveFaviconUrl}
            onClose={() => setShowQrModal(false)}
          />
        </Suspense>
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
                <label className="field__label" htmlFor="modal-edit-motion-number">Motion number (optional)</label>
                <input
                  id="modal-edit-motion-number"
                  className="field__input"
                  type="text"
                  value={editForm.motion_number}
                  onChange={(e) => setEditForm((f) => ({ ...f, motion_number: e.target.value }))}
                  placeholder="e.g. 1, SR-1"
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
                  <option value="special">Special</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    id="modal-edit-is-multi-choice"
                    type="checkbox"
                    checked={editForm.is_multi_choice}
                    onChange={(e) => setEditForm((f) => ({ ...f, is_multi_choice: e.target.checked }))}
                  />
                  Multi-choice question format
                </label>
              </div>
              {editForm.is_multi_choice && (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="edit-option-limit">Max selections per voter</label>
                    <input
                      id="edit-option-limit"
                      className="field__input"
                      type="number"
                      min={1}
                      value={editForm.option_limit}
                      onChange={(e) => setEditForm((f) => ({ ...f, option_limit: e.target.value }))}
                    />
                  </div>
                  <div>
                    <p className="field__label" style={{ marginBottom: 6 }}>Options (min 2)</p>
                    {editForm.options.map((opt, idx) => (
                      <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                        <input
                          aria-label={`Option ${idx + 1}`}
                          className="field__input"
                          type="text"
                          value={opt.text}
                          onChange={(e) => {
                            const updated = [...editForm.options];
                            updated[idx] = { text: e.target.value };
                            setEditForm((f) => ({ ...f, options: updated }));
                          }}
                          placeholder={`Option ${idx + 1}`}
                        />
                        {editForm.options.length > 2 && (
                          <button
                            type="button"
                            className="btn btn--danger btn--sm"
                            aria-label={`Remove option ${idx + 1}`}
                            onClick={() => {
                              const updated = editForm.options.filter((_, i) => i !== idx);
                              setEditForm((f) => ({ ...f, options: updated }));
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setEditForm((f) => ({ ...f, options: [...f.options, { text: "" }] }))}
                    >
                      + Add option
                    </button>
                  </div>
                </>
              )}
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
