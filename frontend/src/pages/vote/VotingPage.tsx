import React, { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchMotions,
  fetchDrafts,
  submitBallot,
  fetchAGMs,
  fetchBuildings,
} from "../../api/voter";
import type { VoteChoice } from "../../types";
import type { AGMOut } from "../../api/voter";
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
  const { agmId } = useParams<{ agmId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverTime = useServerTime();

  const [choices, setChoices] = useState<Record<string, VoteChoice | null>>({});
  const [showDialog, setShowDialog] = useState(false);
  const [highlightUnanswered, setHighlightUnanswered] = useState(false);
  const [isClosed, setIsClosed] = useState(false);

  // Current AGM metadata
  const [currentAgm, setCurrentAgm] = useState<AGMOut | null>(null);
  const [buildingName, setBuildingName] = useState("");

  // Fetch buildings to find the building for this AGM
  const { data: buildings } = useQuery({
    queryKey: ["buildings"],
    queryFn: fetchBuildings,
  });

  useEffect(() => {
    if (!buildings || !agmId) return;

    const findBuilding = async () => {
      for (const building of buildings) {
        try {
          const { fetchAGMs: fetch } = await import("../../api/voter");
          const agms = await fetch(building.id);
          const found = agms.find((a) => a.id === agmId);
          if (found) {
            setCurrentAgm(found);
            setBuildingName(building.name);
            return;
          }
        } catch {
          // continue
        }
      }
    };
    void findBuilding();
  }, [buildings, agmId]);

  const { data: motions } = useQuery({
    queryKey: ["motions", agmId],
    queryFn: () => fetchMotions(agmId!),
    enabled: !!agmId,
  });

  // Load drafts on mount
  const { data: drafts } = useQuery({
    queryKey: ["drafts", agmId],
    queryFn: () => fetchDrafts(agmId!),
    enabled: !!agmId,
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

  // Poll AGM status every 10s
  useEffect(() => {
    if (!agmId || !buildings) return;

    const poll = async () => {
      for (const building of buildings) {
        try {
          const agms = await fetchAGMs(building.id);
          const found = agms.find((a) => a.id === agmId);
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
  }, [agmId, buildings]);

  const submitMutation = useMutation({
    mutationFn: () => submitBallot(agmId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drafts", agmId] });
      navigate(`/vote/${agmId}/confirmation`);
    },
    onError: (error: Error) => {
      if (error.message.includes("409")) {
        navigate(`/vote/${agmId}/confirmation`);
      } else if (error.message.includes("403")) {
        setIsClosed(true);
        setShowDialog(false);
      }
    },
  });

  const handleChoiceChange = (motionId: string, choice: VoteChoice | null) => {
    setChoices((prev) => ({ ...prev, [motionId]: choice }));
  };

  const answeredCount = motions
    ? motions.filter((m) => !!choices[m.id]).length
    : 0;

  const unansweredMotions = motions
    ? motions.filter((m) => !choices[m.id])
    : [];

  const handleSubmitClick = () => {
    setHighlightUnanswered(true);
    setShowDialog(true);
  };

  const handleConfirm = () => {
    setShowDialog(false);
    submitMutation.mutate();
  };

  const handleCancel = () => {
    setShowDialog(false);
  };

  const isWarning =
    currentAgm
      ? Math.floor(
          (new Date(currentAgm.voting_closes_at).getTime() - serverTime.getServerNow()) / 1000
        ) <= 300 &&
        Math.floor(
          (new Date(currentAgm.voting_closes_at).getTime() - serverTime.getServerNow()) / 1000
        ) > 0
      : false;

  return (
    <div>
      {isClosed && <ClosedBanner />}
      {currentAgm && (
        <header>
          <h1>{currentAgm.title}</h1>
          <p>{buildingName}</p>
          <p>Meeting: {formatLocalDateTime(currentAgm.meeting_at)}</p>
          <p>Voting closes: {formatLocalDateTime(currentAgm.voting_closes_at)}</p>
          <CountdownTimer closesAt={currentAgm.voting_closes_at} serverTime={serverTime} />
          {isWarning && (
            <div role="alert" style={{ color: "#e65100", fontWeight: "bold" }}>
              Voting closes in 5 minutes — please submit your ballot
            </div>
          )}
        </header>
      )}

      {motions && (
        <>
          <ProgressBar answered={answeredCount} total={motions.length} />
          {motions.map((motion) => (
            <MotionCard
              key={motion.id}
              motion={motion}
              agmId={agmId!}
              choice={choices[motion.id] ?? null}
              onChoiceChange={handleChoiceChange}
              disabled={isClosed}
              highlight={highlightUnanswered && !choices[motion.id]}
            />
          ))}
          {!isClosed && (
            <button type="button" onClick={handleSubmitClick}>
              Submit Votes
            </button>
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
    </div>
  );
}
