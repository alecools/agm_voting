import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchMotions,
  fetchDrafts,
  saveDraft,
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
  const [showInArrearModal, setShowInArrearModal] = useState(false);

  // Current meeting metadata
  const [currentMeeting, setCurrentMeeting] = useState<GeneralMeetingOut | null>(null);
  const [buildingName, setBuildingName] = useState("");

  // In-arrear lot information
  const [inArrearLotNumbers, setInArrearLotNumbers] = useState<string[]>([]);
  const [hasInArrearLots, setHasInArrearLots] = useState(false);

  useEffect(() => {
    if (!meetingId) return;
    const stored = sessionStorage.getItem(`meeting_lot_info_${meetingId}`);
    if (stored) {
      try {
        const lots = JSON.parse(stored) as LotInfo[];
        const arrearNumbers = lots
          .filter((l) => l.financial_position === "in_arrear")
          .map((l) => l.lot_number);
        setInArrearLotNumbers(arrearNumbers);
        setHasInArrearLots(arrearNumbers.length > 0);
      } catch {
        // ignore parse errors
      }
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

  // Load drafts on mount
  const { data: drafts } = useQuery({
    queryKey: ["drafts", meetingId],
    queryFn: () => fetchDrafts(meetingId!),
    enabled: !!meetingId,
  });

  // Restore draft choices once loaded
  useEffect(() => {
    if (drafts && drafts.drafts.length > 0) {
      const restored: Record<string, VoteChoice | null> = {};
      for (const d of drafts.drafts) {
        restored[d.motion_id] = d.choice;
      }
      setChoices((prev) => ({ ...prev, ...restored }));
    }
  }, [drafts]);

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
      const storedLots = sessionStorage.getItem(`meeting_lots_${meetingId}`);
      const lotOwnerIds: string[] = storedLots ? (JSON.parse(storedLots) as string[]) : [];
      return submitBallot(meetingId!, lotOwnerIds);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drafts", meetingId] });
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

  const handleChoiceChange = (motionId: string, choice: VoteChoice | null) => {
    setChoices((prev) => ({ ...prev, [motionId]: choice }));
  };

  const handleInArrearGeneralMotionClick = () => {
    setShowInArrearModal(true);
  };

  const answeredCount = motions
    ? motions.filter((m) => {
        // In-arrear general motions are auto-answered as not_eligible
        if (hasInArrearLots && m.motion_type === "general") return true;
        return !!choices[m.id];
      }).length
    : 0;

  const unansweredMotions = motions
    ? motions.filter((m) => {
        if (hasInArrearLots && m.motion_type === "general") return false;
        return !choices[m.id];
      })
    : [];

  const handleSubmitClick = () => {
    setHighlightUnanswered(true);
    setShowDialog(true);
  };

  const handleConfirm = () => {
    setShowDialog(false);
    // Flush all pending draft saves before submitting so the debounce in
    // useAutoSave cannot leave choices unpersisted when the backend processes
    // the submission. Errors are swallowed — if a draft save fails we still
    // submit (backend treats missing drafts as abstained, matching existing
    // behaviour for unvoted motions).
    const flushPromises = Object.entries(choices)
      .filter(([, choice]) => choice !== null && choice !== undefined)
      .map(([motionId, choice]) =>
        saveDraft(meetingId!, { motion_id: motionId, choice }).catch(() => undefined)
      );
    void Promise.all(flushPromises).then(() => {
      submitMutation.mutate();
    });
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

  return (
    <main className="voter-content">
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}/lot-selection`)}>
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

      {hasInArrearLots && (
        <div role="alert" className="in-arrear-notice" data-testid="in-arrear-notice">
          Lots [{inArrearLotNumbers.join(", ")}] are in arrear and can only vote on Special Motions.
        </div>
      )}

      {motions && (
        <>
          <ProgressBar answered={answeredCount} total={motions.length} />
          {motions.map((motion) => {
            const isGeneralMotionLockedForInArrear =
              hasInArrearLots && motion.motion_type === "general";
            return (
              <MotionCard
                key={motion.id}
                motion={motion}
                meetingId={meetingId!}
                choice={choices[motion.id] ?? null}
                onChoiceChange={handleChoiceChange}
                disabled={isClosed}
                highlight={
                  highlightUnanswered &&
                  !choices[motion.id] &&
                  !isGeneralMotionLockedForInArrear
                }
                inArrearLocked={isGeneralMotionLockedForInArrear}
                onInArrearClick={handleInArrearGeneralMotionClick}
              />
            );
          })}
          {!isClosed && (
            <div className="submit-section">
              <button type="button" className="btn btn--primary" onClick={handleSubmitClick}>
                Submit ballot
              </button>
            </div>
          )}
        </>
      )}

      {showDialog && (
        <SubmitDialog
          unansweredTitles={unansweredMotions.map((m) => m.title)}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}

      {showInArrearModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="in-arrear-modal-title"
          className="dialog-overlay"
        >
          <div className="dialog">
            <p id="in-arrear-modal-title" className="dialog__message">
              Can&apos;t vote on General Motion as financial position is in arrear.
            </p>
            <div className="dialog__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setShowInArrearModal(false)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
