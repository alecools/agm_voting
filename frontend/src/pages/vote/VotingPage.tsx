import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchMotions,
  submitBallot,
  fetchGeneralMeeting,
  restoreSession,
} from "../../api/voter";
import { optionChoiceMapToRequest } from "../../components/vote/MultiChoiceOptionList";
import type { VoteChoice } from "../../types";
import type { GeneralMeetingWithBuildingOut, LotInfo } from "../../api/voter";

type OptionChoiceMap = Record<string, "for" | "against" | "abstained">;

interface SubmitPayload {
  lotsToSubmit: string[];
  votes: { motion_id: string; choice: VoteChoice }[];
  multiChoiceVotes: { motion_id: string; option_choices: { option_id: string; choice: "for" | "against" | "abstained" }[] }[];
}
import { MotionCard } from "../../components/vote/MotionCard";
import { ProgressBar } from "../../components/vote/ProgressBar";
import { CountdownTimer } from "../../components/vote/CountdownTimer";
import { SubmitDialog } from "../../components/vote/SubmitDialog";
import { MixedSelectionWarningDialog } from "../../components/vote/MixedSelectionWarningDialog";
import { ClosedBanner } from "../../components/vote/ClosedBanner";
import { LotSelectionSection } from "../../components/vote/LotSelectionSection";
import { SubmitSection } from "../../components/vote/SubmitSection";
import { useServerTime } from "../../hooks/useServerTime";
import { formatLocalDateTime } from "../../utils/dateTime";

export function VotingPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverTime = useServerTime();

  const [choices, setChoices] = useState<Record<string, VoteChoice | null>>({});
  // Multi-choice state: motion_id -> { option_id: "for" | "against" | "abstained" }
  // A motion is considered "answered" once the voter interacts (key exists in map, even if {})
  const [multiChoiceSelections, setMultiChoiceSelections] = useState<Record<string, OptionChoiceMap>>({});
  const [showDialog, setShowDialog] = useState(false);
  const [showMixedWarning, setShowMixedWarning] = useState(false);
  const [highlightUnanswered, setHighlightUnanswered] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [meetingNotFound, setMeetingNotFound] = useState(false);

  // Current meeting metadata
  const [currentMeeting, setCurrentMeeting] = useState<GeneralMeetingWithBuildingOut | null>(null);

  // Lot selection state
  const [allLots, setAllLots] = useState<LotInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showNoSelectionError, setShowNoSelectionError] = useState(false);

  // Load allLots from sessionStorage on mount, then immediately restore from server
  // if a session token is available. This ensures voted_motion_ids is always fresh
  // from the DB — not a stale sessionStorage snapshot.
  useEffect(() => {
    if (!meetingId) return;
    const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
    if (!raw) return;
    try {
      const lots = JSON.parse(raw) as LotInfo[];
      setAllLots(lots);
      // Seed selectedIds from sessionStorage as a fast first-render approximation.
      // The [motions, allLots] effect will correct this once motions are known.
      const pending = lots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
      setSelectedIds(new Set(pending));
    } catch {
      // ignore parse errors
    }
  }, [meetingId]);

  // RR4-13: Restore multiChoiceSelections from sessionStorage on mount.
  // This runs after initial render and only seeds state that has not yet been
  // set by the motions-based seeding effect (which runs later when motions load).
  // Using a useEffect (rather than a lazy useState initializer) so that the
  // restore does not interfere with server-seeded selections from already-voted motions.
  useEffect(() => {
    if (!meetingId) return;
    try {
      const raw = sessionStorage.getItem(`meeting_mc_selections_${meetingId}`);
      if (!raw) return;
      const stored = JSON.parse(raw) as Record<string, OptionChoiceMap>;
      // Merge stored selections with any existing state; existing state takes priority
      // so that server-seeded choices (from the motions effect) are not overwritten.
      setMultiChoiceSelections((prev) => ({ ...stored, ...prev }));
    } catch {
      // ignore parse errors — stale or corrupted sessionStorage is acceptable
    }
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // On every VotingPage mount: call restoreSession via the HttpOnly agm_session cookie
  // to get server-authoritative voted_motion_ids from the DB. This ensures that:
  // - voted_motion_ids is not stale from a previous session
  // - isLotSubmitted() derives lock state from fresh data on re-mount
  // The cookie is sent automatically by the browser — no localStorage needed.
  useEffect(() => {
    if (!meetingId) return;

    restoreSession({ general_meeting_id: meetingId })
      .then((response) => {
        const freshLots = response.lots;
        setAllLots(freshLots);
        // Update sessionStorage so the derived state is correct on future renders
        // before the next mount restore.
        sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(freshLots));
      })
      .catch(() => {
        // If session is expired/invalid, leave allLots as loaded from sessionStorage.
        // The voter will need to re-authenticate if they try to submit.
      });
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the meeting directly by ID — single request, no waterfall (RR5-07)
  const { data: meetingData, isError: meetingFetchError } = useQuery({
    queryKey: ["general-meeting", meetingId],
    queryFn: () => fetchGeneralMeeting(meetingId!),
    enabled: !!meetingId,
    retry: false,
  });

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

  const { data: motions } = useQuery({
    queryKey: ["motions", meetingId],
    queryFn: () => fetchMotions(meetingId!),
    enabled: !!meetingId,
  });

  // Derive selectedLots early so that readOnlyReferenceLots and isMotionReadOnly can be
  // defined before the choices seeding effect that depends on them.
  // useMemo ensures selectedLots is a stable reference (only changes when allLots or
  // selectedIds identity changes), preventing isMotionReadOnly from being recreated on
  // every render and causing an infinite loop in the choices seeding useEffect.
  const selectedLots = useMemo(
    () => allLots.filter((l) => selectedIds.has(l.lot_owner_id)),
    [allLots, selectedIds]
  );

  // A motion is read-only when every currently-selected lot has already voted on it.
  // If any selected lot has not yet voted on this motion, it remains interactive so
  // the voter can submit on behalf of that lot.
  // When selectedLots is empty (all lots are already_submitted), fall back to allLots so
  // that motions remain locked rather than becoming editable again.
  // useMemo stabilises the reference so that useCallback([readOnlyReferenceLots]) only
  // creates a new isMotionReadOnly when the underlying lots actually change.
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

  // Seed choices state from submitted_choice when motions load (revote scenario).
  // Only pre-fill a motion when it is locked (isMotionReadOnly is true), meaning every
  // selected lot has already voted on it. Unlocked (interactive) motions must start blank
  // so the voter is not misled into thinking a prior choice has been recorded for their
  // remaining lots.
  useEffect(() => {
    if (!motions) return;
    setChoices((prev) => {
      const seeded: Record<string, VoteChoice | null> = { ...prev };
      for (const m of motions) {
        // Only seed if: not already set in state (avoid overwriting user interactions)
        // AND the motion is locked (all selected lots have voted on it).
        if (
          m.already_voted &&
          m.submitted_choice !== null &&
          !(m.id in seeded) &&
          isMotionReadOnly(m)
        ) {
          seeded[m.id] = m.submitted_choice;
        }
      }
      return seeded;
    });
    // Seed multiChoiceSelections for read-only multi-choice motions so previously
    // submitted option choices are shown when the voter returns to this page.
    setMultiChoiceSelections((prev) => {
      const seeded: Record<string, OptionChoiceMap> = { ...prev };
      for (const m of motions) {
        if (
          m.is_multi_choice &&
          isMotionReadOnly(m) &&
          m.submitted_option_choices &&
          Object.keys(m.submitted_option_choices).length > 0 &&
          !(m.id in seeded)
        ) {
          seeded[m.id] = m.submitted_option_choices as OptionChoiceMap;
        }
      }
      return seeded;
    });
  }, [motions, isMotionReadOnly]);

  // --- Dynamic already-submitted derivation (BUG-NM-01-B fix) ---
  //
  // A lot is effectively "submitted" when every currently-visible motion has a ballot
  // recorded in that lot's voted_motion_ids. This mirrors the server-side computation in
  // POST /api/auth/verify and POST /api/auth/session.
  //
  // Because `motions` is live React Query state, isLotSubmitted() automatically returns
  // false the moment a new motion appears — without any manual effect or ref tracking.
  // This eliminates the re-mount bug (BUG-NM-01-B) caused by prevMotionCountRef resetting.
  const isLotSubmitted = useCallback(
    (lot: LotInfo): boolean => {
      if (!motions || motions.length === 0) return false;
      return motions.every((m) => (lot.voted_motion_ids ?? []).includes(m.id));
    },
    [motions]
  );

  // Re-seed selectedIds whenever motions or allLots change.
  // This handles the case where motions refetch reveals new motions that make a
  // previously-submitted lot not-yet-submitted again (it was locked, now unlocked).
  useEffect(() => {
    if (!motions || allLots.length === 0) return;
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

  // Poll meeting status every 10s — single endpoint, clears interval on closure (RR5-07, RR5-14)
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

  const submitMutation = useMutation({
    mutationFn: ({ lotsToSubmit, votes, multiChoiceVotes }: SubmitPayload) =>
      submitBallot(meetingId!, {
        lot_owner_ids: lotsToSubmit,
        votes,
        multi_choice_votes: multiChoiceVotes.map(({ motion_id, option_choices }) => ({
          motion_id,
          option_choices,
        })),
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

      // Use the lot IDs captured at trigger time (passed as mutation variables),
      // not a re-read from sessionStorage which may have been cleared.
      const submittedIds = variables.lotsToSubmit;
      const submittedSet = new Set(submittedIds);

      // Collect the current motion IDs so we can merge them into voted_motion_ids.
      const currentMotionIds = motions ? motions.map((m) => m.id) : [];

      // Write sessionStorage synchronously here, before navigate(), so that when the voter
      // returns to VotingPage via "View my votes", the re-mount useEffect reads the correct
      // already_submitted state and voted_motion_ids. React Router v6's navigate() wraps in
      // startTransition internally; any side-effect inside a setAllLots functional updater may
      // not execute before the component unmounts under concurrent rendering (BUG-AS-01).
      if (meetingId) {
        try {
          const currentLots = JSON.parse(
            sessionStorage.getItem(`meeting_lots_info_${meetingId}`) ?? "[]"
          ) as LotInfo[];
          const updatedLots = currentLots.map((lot) =>
            submittedSet.has(lot.lot_owner_id)
              ? {
                  ...lot,
                  already_submitted: true,
                  voted_motion_ids: Array.from(
                    new Set([...(lot.voted_motion_ids ?? []), ...currentMotionIds])
                  ),
                }
              : lot
          );
          sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(updatedLots));
        } catch {
          // ignore parse errors — stale sessionStorage is acceptable; fresh data comes from re-auth
        }
      }

      // Also update in-memory React state so the UI is consistent for the brief period
      // before navigation completes (and to keep the in-memory state correct if navigate is delayed).
      setAllLots((prev) =>
        prev.map((lot) =>
          submittedSet.has(lot.lot_owner_id)
            ? {
                ...lot,
                already_submitted: true,
                voted_motion_ids: Array.from(
                  new Set([...(lot.voted_motion_ids ?? []), ...currentMotionIds])
                ),
              }
            : lot
        )
      );

      // Remove submitted lot IDs from selection to prevent stale selectedIds
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of submittedSet) next.delete(id);
        return next;
      });

      navigate(`/vote/${meetingId}/confirmation`);
    },
    onError: (error: Error) => {
      if (error.message.includes("409")) {
        navigate(`/vote/${meetingId}/confirmation`);
      } else if (error.message.includes("403")) {
        setIsClosed(true);
        setShowDialog(false);
      }
    },
  });

  // Derived values for lot panel
  const isMultiLot = allLots.length > 1;
  const allSubmitted = allLots.length > 0 && allLots.every((l) => isLotSubmitted(l));
  const pendingLots = allLots.filter((l) => !isLotSubmitted(l));
  const votingCount = isMultiLot ? selectedIds.size : pendingLots.length;

  // In-arrear warning banner: computed from the currently selected lots
  // (selectedLots is defined earlier to satisfy the isMotionReadOnly useCallback dependency order)
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

  const handleChoiceChange = (motionId: string, choice: VoteChoice | null) => {
    setChoices((prev) => ({ ...prev, [motionId]: choice }));
  };

  const handleMultiChoiceChange = (motionId: string, newChoices: OptionChoiceMap) => {
    setMultiChoiceSelections((prev) => {
      const next = { ...prev, [motionId]: newChoices };
      // RR4-13: persist to sessionStorage on every update so state survives page refresh
      if (meetingId) {
        sessionStorage.setItem(`meeting_mc_selections_${meetingId}`, JSON.stringify(next));
      }
      return next;
    });
  };

  // A motion is "individually closed" when voting_closed_at is set and the voter
  // has not already answered it. These motions are excluded from the progress bar
  // denominator and their controls are disabled (voter cannot interact with them).
  const isMotionIndividuallyClosed = (m: { id: string; voting_closed_at?: string | null }) =>
    !!m.voting_closed_at && !isMotionReadOnly(m);

  // Only count motions the voter can still interact with towards the progress bar.
  // Exclude individually-closed motions (voter had no chance to answer them).
  const unvotedMotions = motions
    ? motions.filter((m) => !isMotionReadOnly(m) && !isMotionIndividuallyClosed(m))
    : [];
  const answeredCount = unvotedMotions.filter((m) =>
    m.is_multi_choice
      ? m.id in multiChoiceSelections  // answered once any interaction recorded
      : !!choices[m.id]
  ).length;

  const unansweredMotions = unvotedMotions.filter((m) =>
    m.is_multi_choice
      ? !(m.id in multiChoiceSelections)
      : !choices[m.id]
  );

  // Check whether selected lots have mixed vote coverage (some have prior votes, others don't).
  // Returns true only when two or more lots have different voted_motion_ids sets.
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
    // Persist the selected lot IDs so submitMutation can read them
    if (isMultiLot) {
      sessionStorage.setItem(
        `meeting_lots_${meetingId}`,
        JSON.stringify([...selectedIds])
      );
    }
    // Show mixed selection warning before proceeding to the submit dialog
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

  const handleConfirm = () => {
    setShowDialog(false);
    // Capture all submission values synchronously at confirm time and pass directly
    // into mutate() — never re-read from sessionStorage inside the async mutationFn.
    const lotsToSubmit = isMultiLot ? [...selectedIds] : allLots.map((l) => l.lot_owner_id);
    const votes = Object.entries(choices)
      .filter(([, choice]) => choice !== null)
      .map(([motion_id, choice]) => ({ motion_id, choice: choice as VoteChoice }));
    const multiChoiceVotes = Object.entries(multiChoiceSelections).map(
      ([motion_id, choices]) => ({ motion_id, option_choices: optionChoiceMapToRequest(choices) })
    );
    submitMutation.mutate({ lotsToSubmit, votes, multiChoiceVotes });
  };

  const handleCancel = () => {
    setShowDialog(false);
  };

  const secsRemaining = currentMeeting
    ? Math.floor(
        (new Date(currentMeeting.voting_closes_at).getTime() - serverTime.getServerNow()) / 1000
      )
    : Infinity;

  const isWarning = secsRemaining <= 300 && secsRemaining > 0;

  // Sidebar is only rendered for multi-lot voters (single-lot voters see motions full-width)
  const showSidebar = isMultiLot && allLots.length > 0;

  // Lot list content — shared between desktop sidebar and mobile drawer (US-CQM-03)
  const lotListContent = showSidebar ? (
    <LotSelectionSection
      allLots={allLots}
      selectedIds={selectedIds}
      allSubmitted={allSubmitted}
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

  // Desktop sidebar (hidden on mobile via CSS)
  const sidebarContent = showSidebar ? (
    <div className="voting-layout__sidebar">
      {lotListContent}
    </div>
  ) : null;

  // Mobile drawer overlay (hidden on desktop via CSS)
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

  // Error state: meeting not found after all queries complete (RR3-27)
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
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}/auth`)}>
        ← Back
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
          {/* Mobile drawer open button — only shown on mobile via CSS */}
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

          {/* Single-lot proxy voters: show a compact lot info strip above motions */}
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
                        {motionClosed && (
                          <div
                            className="motion-closed-label"
                            data-testid={`motion-closed-label-${motion.id}`}
                            role="status"
                          >
                            Voting closed
                          </div>
                        )}
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
                          multiChoiceOptionChoices={multiChoiceSelections[motion.id] ?? {}}
                          onMultiChoiceChange={handleMultiChoiceChange}
                        />
                      </div>
                    );
                  })}
                  {/* RR3-39: aria-live region announces vote status updates to screen readers */}
                  <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="vote-status-announcer">
                    {submitMutation.isSuccess ? "Your vote has been saved." : ""}
                  </div>
                  {/* US-CQM-03: SubmitSection encapsulates submit/view submission rendering */}
                  <SubmitSection
                    unvotedCount={unvotedMotions.length}
                    isClosed={isClosed}
                    showSidebar={showSidebar}
                    isPending={submitMutation.isPending}
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
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </main>
  );
}
