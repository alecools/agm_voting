import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchMotions,
  fetchGeneralMeeting,
  restoreSession,
  logout,
} from "../../api/voter";
import type { GeneralMeetingWithBuildingOut, LotInfo } from "../../api/voter";
import { MotionCard } from "../../components/vote/MotionCard";
import { ProgressBar } from "../../components/vote/ProgressBar";
import { CountdownTimer } from "../../components/vote/CountdownTimer";
import { SubmitDialog } from "../../components/vote/SubmitDialog";
import { MixedSelectionWarningDialog } from "../../components/vote/MixedSelectionWarningDialog";
import { ClosedBanner } from "../../components/vote/ClosedBanner";
import { LotSelectionSection } from "../../components/vote/LotSelectionSection";
import { SubmitSection } from "../../components/vote/SubmitSection";
import { useServerTime } from "../../hooks/useServerTime";
import { useVotingState } from "../../hooks/useVotingState";
import { useMotionSubmission } from "../../hooks/useMotionSubmission";
import { formatLocalDateTime } from "../../utils/dateTime";

export function VotingPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverTime = useServerTime();

  const [showDialog, setShowDialog] = useState(false);
  const [showMixedWarning, setShowMixedWarning] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [meetingNotFound, setMeetingNotFound] = useState(false);

  // Current meeting metadata
  const [currentMeeting, setCurrentMeeting] = useState<GeneralMeetingWithBuildingOut | null>(null);

  // Lot selection state
  const [allLots, setAllLots] = useState<LotInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showNoSelectionError, setShowNoSelectionError] = useState(false);

  // Tracks the motions count from the previous re-seed run.
  const prevMotionsLengthRef = useRef(0);

  // Load allLots from sessionStorage on mount
  useEffect(() => {
    if (!meetingId) return;
    const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
    if (!raw) return;
    try {
      const lots = JSON.parse(raw) as LotInfo[];
      setAllLots(lots);
      const pending = lots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
      setSelectedIds(new Set(pending));
    } catch {
      // ignore parse errors
    }
  }, [meetingId]);

  // On every VotingPage mount: restore session via HttpOnly cookie
  useEffect(() => {
    if (!meetingId) return;

    restoreSession({ general_meeting_id: meetingId })
      .then((response) => {
        const freshLots = response.lots;
        setAllLots(freshLots);
        sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(freshLots));
      })
      .catch(() => {
        // session expired — leave allLots as loaded from sessionStorage
      });
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch motions and meeting data in parallel
  const {
    data: motionsAndMeeting,
    isError: meetingFetchError,
  } = useQuery({
    queryKey: ["voting-init", meetingId],
    queryFn: () => Promise.all([fetchMotions(meetingId!), fetchGeneralMeeting(meetingId!)]),
    enabled: !!meetingId,
    retry: false,
  });

  const motions = motionsAndMeeting?.[0];
  const meetingData = motionsAndMeeting?.[1];

  useEffect(() => {
    if (!meetingId) return;
    if (meetingFetchError) {
      setMeetingNotFound(true);
      return;
    }
    if (meetingData) {
      setMeetingNotFound(false);
      setCurrentMeeting(meetingData);
    }
  }, [meetingData, meetingFetchError, meetingId]);

  const selectedLots = useMemo(
    () => allLots.filter((l) => selectedIds.has(l.lot_owner_id)),
    [allLots, selectedIds]
  );

  const readOnlyReferenceLots = useMemo(
    () => (selectedLots.length > 0 ? selectedLots : allLots),
    [selectedLots, allLots]
  );
  const isMotionReadOnly = useCallback(
    (m: { id: string }) =>
      readOnlyReferenceLots.length > 0 &&
      readOnlyReferenceLots.every((lot) => (lot.voted_motion_ids ?? []).includes(m.id)),
    [readOnlyReferenceLots]
  );

  const isLotSubmitted = useCallback(
    (lot: LotInfo): boolean => {
      if (!motions || motions.length === 0) return false;
      return motions.every((m) => (lot.voted_motion_ids ?? []).includes(m.id));
    },
    [motions]
  );

  // Re-seed selectedIds when new motions are revealed
  useEffect(() => {
    if (!motions || allLots.length === 0) return;
    if (motions.length <= prevMotionsLengthRef.current && prevMotionsLengthRef.current > 0) return;
    prevMotionsLengthRef.current = motions.length;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const lot of allLots) {
        if (!isLotSubmitted(lot)) {
          next.add(lot.lot_owner_id);
        } else {
          next.delete(lot.lot_owner_id);
        }
      }
      return next;
    });
  }, [motions, allLots, isLotSubmitted]);

  // Poll meeting status every 10s
  useEffect(() => {
    if (!meetingId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const meeting = await fetchGeneralMeeting(meetingId);
        if (meeting.status === "closed") {
          setIsClosed(true);
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch {
        // transient error — continue polling
      }
    };

    intervalId = setInterval(() => void poll(), 10000);
    return () => {
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [meetingId]);

  const isMotionIndividuallyClosed = (m: { id: string; voting_closed_at?: string | null }) =>
    !!m.voting_closed_at && !isMotionReadOnly(m);

  const unvotedMotions = motions
    ? motions.filter((m) => !isMotionReadOnly(m) && !isMotionIndividuallyClosed(m))
    : [];

  const isMultiLot = allLots.length > 1;

  // useVotingState: manages choices, multiChoiceSelections, highlight, answeredCount
  const {
    choices,
    multiChoiceSelections,
    highlightUnanswered,
    setHighlightUnanswered,
    handleChoiceChange,
    handleMultiChoiceChange,
    resetMultiChoiceSelections,
    answeredCount,
    unansweredMotions,
  } = useVotingState({
    meetingId,
    motions,
    isMotionReadOnly,
    unvotedMotions,
  });

  // useMotionSubmission: manages submit mutation and handlers
  const { isPending: isSubmitPending, handleConfirm, handleCancel } = useMotionSubmission({
    meetingId,
    motions,
    isMultiLot,
    selectedIds,
    allLots,
    isMotionReadOnly,
    callbacks: {
      setAllLots,
      setSelectedIds,
      resetMultiChoiceSelections,
      setIsClosed,
      setShowDialog,
    },
  });

  // Derived values for lot panel
  const allSubmitted = allLots.length > 0 && allLots.every((l) => isLotSubmitted(l));
  const anySubmitted = allLots.some((l) => (l.voted_motion_ids?.length ?? 0) > 0);
  const pendingLots = allLots.filter((l) => !isLotSubmitted(l));
  const votingCount = isMultiLot ? selectedIds.size : pendingLots.length;

  const selectedInArrearCount = selectedLots.filter((l) => l.financial_position === "in_arrear").length;
  const selectedNormalCount = selectedLots.filter((l) => l.financial_position !== "in_arrear").length;
  const arrearBannerMode: "none" | "mixed" | "all" =
    selectedInArrearCount === 0
      ? "none"
      : selectedNormalCount === 0
      ? "all"
      : "mixed";

  const handleToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setShowNoSelectionError(false);
  };

  const handleSelectAll = () => {
    const pendingIds = allLots.filter((l) => !isLotSubmitted(l)).map((l) => l.lot_owner_id);
    setSelectedIds(new Set(pendingIds));
    setShowNoSelectionError(false);
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleSelectProxy = () => {
    const proxyIds = allLots.filter((l) => l.is_proxy && !isLotSubmitted(l)).map((l) => l.lot_owner_id);
    setSelectedIds(new Set(proxyIds));
    setShowNoSelectionError(false);
  };

  const handleSelectOwned = () => {
    const ownedIds = allLots.filter((l) => !l.is_proxy && !isLotSubmitted(l)).map((l) => l.lot_owner_id);
    setSelectedIds(new Set(ownedIds));
    setShowNoSelectionError(false);
  };

  const hasProxyLot = allLots.some((l) => l.is_proxy);

  const handleViewSubmission = () => {
    navigate(`/vote/${meetingId}/confirmation`);
  };

  const handleSignOut = useCallback(() => {
    logout().catch(() => {});
    if (meetingId) {
      sessionStorage.removeItem(`meeting_lots_${meetingId}`);
      sessionStorage.removeItem(`meeting_lots_info_${meetingId}`);
      sessionStorage.removeItem(`meeting_lot_info_${meetingId}`);
      sessionStorage.removeItem(`meeting_building_name_${meetingId}`);
      sessionStorage.removeItem(`meeting_title_${meetingId}`);
      sessionStorage.removeItem(`meeting_mc_selections_${meetingId}`);
    }
    queryClient.clear();
    navigate("/");
  }, [meetingId, queryClient, navigate]);

  const hasMixedVoteStatus = (): boolean => {
    if (selectedLots.length <= 1) return false;
    const firstIds = new Set(selectedLots[0].voted_motion_ids ?? []);
    return selectedLots.slice(1).some((lot) => {
      const ids = new Set(lot.voted_motion_ids ?? []);
      if (ids.size !== firstIds.size) return true;
      return [...ids].some((id) => !firstIds.has(id));
    });
  };

  const handleSubmitClick = () => {
    if (isMultiLot && selectedIds.size === 0) {
      setShowNoSelectionError(true);
      return;
    }
    if (isMultiLot) {
      sessionStorage.setItem(
        `meeting_lots_${meetingId}`,
        JSON.stringify([...selectedIds])
      );
    }
    if (hasMixedVoteStatus()) {
      setShowMixedWarning(true);
      return;
    }
    setHighlightUnanswered(true);
    setShowDialog(true);
  };

  const handleMixedWarningContinue = () => {
    setShowMixedWarning(false);
    setHighlightUnanswered(true);
    setShowDialog(true);
  };

  const handleMixedWarningGoBack = () => {
    setShowMixedWarning(false);
  };

  const secsRemaining = currentMeeting
    ? Math.floor(
        (new Date(currentMeeting.voting_closes_at).getTime() - serverTime.getServerNow()) / 1000
      )
    : Infinity;

  const isWarning = secsRemaining <= 300 && secsRemaining > 0;

  const showSidebar = isMultiLot && allLots.length > 0;

  const lotListContent = showSidebar ? (
    <LotSelectionSection
      allLots={allLots}
      selectedIds={selectedIds}
      allSubmitted={allSubmitted}
      anySubmitted={anySubmitted}
      votingCount={votingCount}
      hasProxyLot={hasProxyLot}
      showNoSelectionError={showNoSelectionError}
      isLotSubmitted={isLotSubmitted}
      onToggle={handleToggle}
      onSelectAll={handleSelectAll}
      onDeselectAll={handleDeselectAll}
      onSelectProxy={handleSelectProxy}
      onSelectOwned={handleSelectOwned}
      onViewSubmission={handleViewSubmission}
    />
  ) : null;

  const sidebarContent = showSidebar ? (
    <div className="voting-layout__sidebar">
      {lotListContent}
    </div>
  ) : null;

  const mobileDrawer = showSidebar ? (
    <>
      {isDrawerOpen && (
        <div
          className="sidebar-drawer__backdrop"
          onClick={() => setIsDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={`sidebar-drawer${isDrawerOpen ? " sidebar-drawer--open" : ""}`}
        aria-hidden={!isDrawerOpen}
      >
        <button
          type="button"
          className="sidebar-drawer__close"
          aria-label="Close lot selector"
          onClick={() => setIsDrawerOpen(false)}
        >
          ✕
        </button>
        {lotListContent}
      </div>
    </>
  ) : null;

  if (meetingNotFound) {
    return (
      <main className="voter-content">
        <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}/auth`)}>
          ← Back
        </button>
        <p
          className="state-message state-message--error"
          role="alert"
          data-testid="meeting-not-found-error"
        >
          Meeting not found — please check the link and try again.
        </p>
      </main>
    );
  }

  return (
    <main className="voter-content">
      <button type="button" className="btn btn--ghost back-btn" onClick={handleSignOut}>
        Sign out
      </button>
      {isClosed && <ClosedBanner />}
      {isWarning && !isClosed && (
        <div role="alert" className="warning-banner">
          <span aria-hidden="true">⚠</span>
          Voting closes in 5 minutes — please submit your ballot
        </div>
      )}

      {currentMeeting && (
        <div className="agm-header">
          <p className="agm-header__building">{currentMeeting.building_name}</p>
          <h1 className="agm-header__title">{currentMeeting.title}</h1>
          <div className="agm-header__meta">
            <span>
              <strong>Meeting</strong>{" "}
              {formatLocalDateTime(currentMeeting.meeting_at)}
            </span>
            <span>
              <strong>Closes</strong>{" "}
              {formatLocalDateTime(currentMeeting.voting_closes_at)}
            </span>
          </div>
          <div className="agm-header__divider" />
          <span className="agm-header__timer-label">Time remaining</span>
          <CountdownTimer closesAt={currentMeeting.voting_closes_at} serverTime={serverTime} />
        </div>
      )}

      {mobileDrawer}

      <div className={showSidebar ? "voting-layout" : undefined}>
        {sidebarContent}

        <div className={showSidebar ? "voting-layout__main" : undefined}>
          {showSidebar && (
            <button
              type="button"
              className="sidebar-drawer-open-btn"
              onClick={() => setIsDrawerOpen(true)}
              aria-label="Open lot selector"
            >
              ☰ Your Lots
            </button>
          )}

          {!isMultiLot && allLots.length === 1 && allLots[0].is_proxy && (
            <div className="lot-selection lot-selection--inline">
              <h2 className="lot-selection__title">Your Lots</h2>
              <ul className="lot-selection__list" role="list">
                <li
                  className={`lot-selection__item${isLotSubmitted(allLots[0]) ? " lot-selection__item--submitted" : ""}`}
                  aria-disabled={isLotSubmitted(allLots[0]) ? "true" : undefined}
                >
                  <span className="lot-selection__lot-number">Lot {allLots[0].lot_number}</span>
                  <span className="lot-selection__badge lot-selection__badge--proxy">
                    via Proxy
                  </span>
                  {isLotSubmitted(allLots[0]) && (
                    <span className="lot-selection__badge lot-selection__badge--submitted">
                      Already submitted
                    </span>
                  )}
                </li>
              </ul>
              {isLotSubmitted(allLots[0]) && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleViewSubmission}
                >
                  View Submission
                </button>
              )}
            </div>
          )}

          {motions && (
            <>
              {motions.length === 0 ? (
                <p className="state-message" data-testid="no-motions-message">
                  No motions are available yet. Please check back shortly.
                </p>
              ) : (
                <>
                  <ProgressBar answered={answeredCount} total={unvotedMotions.length} />
                  {arrearBannerMode !== "none" && (
                    <div className="arrear-notice" data-testid="arrear-banner" role="note">
                      {arrearBannerMode === "all"
                        ? "All your selected lots are in arrear. You may only vote on Special Motions — General Motion votes will be recorded as not eligible."
                        : "Some of your selected lots are in arrear. Your votes on General Motions will not count for in-arrear lots — they will be recorded as not eligible. Votes for all other lots will be recorded normally."}
                    </div>
                  )}
                  {motions.map((motion) => {
                    const motionClosed = isMotionIndividuallyClosed(motion);
                    return (
                      <div key={motion.id}>
                        <MotionCard
                          motion={motion}
                          position={motion.display_order}
                          choice={choices[motion.id] ?? null}
                          onChoiceChange={handleChoiceChange}
                          disabled={isClosed || motionClosed}
                          highlight={
                            highlightUnanswered &&
                            !isMotionReadOnly(motion) &&
                            !motionClosed &&
                            (motion.is_multi_choice
                              ? !(motion.id in multiChoiceSelections)
                              : !choices[motion.id])
                          }
                          readOnly={isMotionReadOnly(motion)}
                          votingClosed={motionClosed}
                          multiChoiceOptionChoices={multiChoiceSelections[motion.id] ?? {}}
                          onMultiChoiceChange={handleMultiChoiceChange}
                        />
                      </div>
                    );
                  })}
                  <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="vote-status-announcer">
                    {isSubmitPending ? "Submitting your ballot..." : ""}
                  </div>
                  <SubmitSection
                    unvotedCount={unvotedMotions.length}
                    isClosed={isClosed}
                    showSidebar={showSidebar}
                    allSubmitted={allSubmitted}
                    isPending={isSubmitPending}
                    onSubmitClick={handleSubmitClick}
                    onViewSubmission={handleViewSubmission}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>

      {showMixedWarning && (
        <MixedSelectionWarningDialog
          differingLots={selectedLots.filter((lot) => {
            const ids = new Set(lot.voted_motion_ids ?? []);
            return ids.size > 0 || selectedLots.some((other) => {
              const otherIds = new Set(other.voted_motion_ids ?? []);
              return ids.size !== otherIds.size || [...ids].some((id) => !otherIds.has(id));
            });
          })}
          onContinue={handleMixedWarningContinue}
          onGoBack={handleMixedWarningGoBack}
        />
      )}
      {showDialog && (
        <SubmitDialog
          unansweredMotions={unansweredMotions.map((m) => ({ display_order: m.display_order, motion_number: m.motion_number, title: m.title }))}
          onConfirm={() => handleConfirm({ choices, multiChoiceSelections })}
          onCancel={handleCancel}
        />
      )}
    </main>
  );
}
