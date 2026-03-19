import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchMotions,
  submitBallot,
  fetchGeneralMeetings,
  fetchBuildings,
} from "../../api/voter";
import type { VoteChoice } from "../../types";
import type { GeneralMeetingOut, LotInfo } from "../../api/voter";
import { MotionCard } from "../../components/vote/MotionCard";
import { ProgressBar } from "../../components/vote/ProgressBar";
import { CountdownTimer } from "../../components/vote/CountdownTimer";
import { SubmitDialog } from "../../components/vote/SubmitDialog";
import { ClosedBanner } from "../../components/vote/ClosedBanner";
import { useServerTime } from "../../hooks/useServerTime";

function formatLocalDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function VotingPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverTime = useServerTime();

  const [choices, setChoices] = useState<Record<string, VoteChoice | null>>({});
  const [showDialog, setShowDialog] = useState(false);
  const [highlightUnanswered, setHighlightUnanswered] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Current meeting metadata
  const [currentMeeting, setCurrentMeeting] = useState<GeneralMeetingOut | null>(null);
  const [buildingName, setBuildingName] = useState("");

  // Lot selection state
  const [allLots, setAllLots] = useState<LotInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showNoSelectionError, setShowNoSelectionError] = useState(false);

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

  // Fetch buildings to find the building for this meeting
  const { data: buildings } = useQuery({
    queryKey: ["buildings"],
    queryFn: fetchBuildings,
  });

  useEffect(() => {
    if (!buildings || !meetingId) return;

    const findBuilding = async () => {
      for (const building of buildings) {
        try {
          const meetings = await fetchGeneralMeetings(building.id);
          const found = meetings.find((a) => a.id === meetingId);
          if (found) {
            setCurrentMeeting(found);
            setBuildingName(building.name);
            return;
          }
        } catch {
          // continue
        }
      }
    };
    void findBuilding();
  }, [buildings, meetingId]);

  const { data: motions } = useQuery({
    queryKey: ["motions", meetingId],
    queryFn: () => fetchMotions(meetingId!),
    enabled: !!meetingId,
  });

  // Poll meeting status every 10s
  useEffect(() => {
    if (!meetingId || !buildings) return;

    const poll = async () => {
      for (const building of buildings) {
        try {
          const meetings = await fetchGeneralMeetings(building.id);
          const found = meetings.find((a) => a.id === meetingId);
          if (found && found.status === "closed") {
            setIsClosed(true);
            return;
          }
          if (found) return;
        } catch {
          // continue
        }
      }
    };

    const id = setInterval(() => void poll(), 10000);
    return () => clearInterval(id);
  }, [meetingId, buildings]);

  const submitMutation = useMutation({
    mutationFn: () => {
      // For multi-lot voters: use the currently selected IDs (written to sessionStorage
      // when Submit is clicked). For single-lot voters: fall back to stored lots.
      const storedLots = sessionStorage.getItem(`meeting_lots_${meetingId}`);
      const lotOwnerIds: string[] = storedLots ? (JSON.parse(storedLots) as string[]) : [];
      const votes = Object.entries(choices)
        .filter(([, choice]) => choice !== null)
        .map(([motion_id, choice]) => ({ motion_id, choice: choice as string }));
      return submitBallot(meetingId!, { lot_owner_ids: lotOwnerIds, votes });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["motions", meetingId] });

      // Determine which lot IDs were just submitted (written to sessionStorage by handleSubmitClick)
      const raw = sessionStorage.getItem(`meeting_lots_${meetingId}`);
      const submittedIds: string[] = raw ? (JSON.parse(raw) as string[]) : [];
      const submittedSet = new Set(submittedIds);

      // Mark just-submitted lots as already_submitted and sync sessionStorage so that
      // back-navigation within the same browser session reflects the updated state
      setAllLots((prev) => {
        const updated = prev.map((lot) =>
          submittedSet.has(lot.lot_owner_id)
            ? { ...lot, already_submitted: true }
            : lot
        );
        if (meetingId) {
          sessionStorage.setItem(`meeting_lots_info_${meetingId}`, JSON.stringify(updated));
        }
        return updated;
      });

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
  const allSubmitted = allLots.length > 0 && allLots.every((l) => l.already_submitted);
  const pendingLots = allLots.filter((l) => !l.already_submitted);
  const votingCount = isMultiLot ? selectedIds.size : pendingLots.length;

  // In-arrear warning banner: computed from the currently selected lots
  const selectedLots = allLots.filter((l) => selectedIds.has(l.lot_owner_id));
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
    const pendingIds = allLots.filter((l) => !l.already_submitted).map((l) => l.lot_owner_id);
    setSelectedIds(new Set(pendingIds));
    setShowNoSelectionError(false);
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleSelectProxy = () => {
    const proxyIds = allLots.filter((l) => l.is_proxy && !l.already_submitted).map((l) => l.lot_owner_id);
    setSelectedIds(new Set(proxyIds));
    setShowNoSelectionError(false);
  };

  const handleSelectOwned = () => {
    const ownedIds = allLots.filter((l) => !l.is_proxy && !l.already_submitted).map((l) => l.lot_owner_id);
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

  // A motion is read-only only when the voter has already voted on it AND there are no
  // currently-selected lots that still need to submit.  If any selected lot is unsubmitted,
  // the voter can still cast votes for those lots on all motions.
  const hasUnsubmittedSelected = selectedLots.some((l) => !l.already_submitted);
  const isMotionReadOnly = (m: { already_voted: boolean }) =>
    m.already_voted && !hasUnsubmittedSelected;

  // Only count motions the voter can still interact with towards the progress bar.
  const unvotedMotions = motions ? motions.filter((m) => !isMotionReadOnly(m)) : [];
  const answeredCount = unvotedMotions.filter((m) => !!choices[m.id]).length;

  const unansweredMotions = unvotedMotions.filter((m) => !choices[m.id]);

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
    setHighlightUnanswered(true);
    setShowDialog(true);
  };

  const handleConfirm = () => {
    setShowDialog(false);
    // Vote choices live in React state only — submit directly, no draft flush needed.
    submitMutation.mutate();
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

  // Lot list content — shared between desktop sidebar and mobile drawer
  const lotListContent = showSidebar ? (
    <div className="lot-selection">
      <h2 className="lot-selection__title">Your Lots</h2>
      <p className="lot-selection__subtitle">
        {allSubmitted
          ? "All lots have been submitted."
          : `You are voting for ${votingCount} lot${votingCount !== 1 ? "s" : ""}.`}
      </p>

      <div className="lot-shortcut-buttons">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={handleSelectAll}
          aria-label="Select all lots"
        >
          Select All
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={handleDeselectAll}
          aria-label="Deselect all lots"
        >
          Deselect All
        </button>
        {hasProxyLot && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={handleSelectProxy}
            aria-label="Select proxy lots only"
          >
            Select Proxy Lots
          </button>
        )}
        {hasProxyLot && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={handleSelectOwned}
            aria-label="Select owned lots only"
          >
            Select Owned Lots
          </button>
        )}
      </div>

      <ul className="lot-selection__list" role="list">
        {allLots.map((lot) => (
          <li
            key={lot.lot_owner_id}
            className={`lot-selection__item${lot.already_submitted ? " lot-selection__item--submitted" : ""}`}
            aria-disabled={lot.already_submitted ? "true" : undefined}
          >
            <input
              type="checkbox"
              id={`lot-checkbox-${lot.lot_owner_id}`}
              className="lot-selection__checkbox"
              checked={selectedIds.has(lot.lot_owner_id)}
              disabled={lot.already_submitted}
              onChange={() => handleToggle(lot.lot_owner_id)}
              aria-label={`Select Lot ${lot.lot_number}`}
            />

            <span className="lot-selection__lot-number">Lot {lot.lot_number}</span>

            {lot.is_proxy && (
              <span className="lot-selection__badge lot-selection__badge--proxy">
                via Proxy
              </span>
            )}

            {lot.financial_position === "in_arrear" && (
              <span className="lot-selection__badge lot-selection__badge--arrear">
                In Arrear
              </span>
            )}

            {lot.already_submitted && (
              <span className="lot-selection__badge lot-selection__badge--submitted">
                Already submitted
              </span>
            )}
          </li>
        ))}
      </ul>

      {showNoSelectionError && (
        <p role="alert">Please select at least one lot</p>
      )}

      {allSubmitted && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleViewSubmission}
        >
          View Submission
        </button>
      )}
    </div>
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

  return (
    <main className="voter-content">
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}`)}>
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
          <p className="agm-header__building">{buildingName}</p>
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
                  className={`lot-selection__item${allLots[0].already_submitted ? " lot-selection__item--submitted" : ""}`}
                  aria-disabled={allLots[0].already_submitted ? "true" : undefined}
                >
                  <span className="lot-selection__lot-number">Lot {allLots[0].lot_number}</span>
                  <span className="lot-selection__badge lot-selection__badge--proxy">
                    via Proxy
                  </span>
                  {allLots[0].already_submitted && (
                    <span className="lot-selection__badge lot-selection__badge--submitted">
                      Already submitted
                    </span>
                  )}
                </li>
              </ul>
              {allLots[0].already_submitted && (
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
                  {motions.map((motion) => (
                    <MotionCard
                      key={motion.id}
                      motion={motion}
                      choice={choices[motion.id] ?? null}
                      onChoiceChange={handleChoiceChange}
                      disabled={isClosed}
                      highlight={highlightUnanswered && !isMotionReadOnly(motion) && !choices[motion.id]}
                      readOnly={isMotionReadOnly(motion)}
                    />
                  ))}
                  {unvotedMotions.length === 0 && !isClosed && !showSidebar && (
                    <div className="submit-section">
                      <button type="button" className="btn btn--primary" onClick={handleViewSubmission}>
                        View Submission
                      </button>
                    </div>
                  )}
                  {unvotedMotions.length > 0 && !isClosed && !allSubmitted && (
                    <div className="submit-section">
                      <button type="button" className="btn btn--primary" onClick={handleSubmitClick}>
                        Submit ballot
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {showDialog && (
        <SubmitDialog
          unansweredTitles={unansweredMotions.map((m) => m.title)}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </main>
  );
}
