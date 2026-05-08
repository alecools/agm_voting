import { useState, useEffect, useRef } from "react";
import type { VoteChoice } from "../types";
import type { MotionOut } from "../api/voter";

export type OptionChoiceMap = Record<string, "for" | "against" | "abstained">;

interface UseVotingStateParams {
  meetingId: string | undefined;
  motions: MotionOut[] | undefined;
  isMotionReadOnly: (m: { id: string }) => boolean;
  unvotedMotions: MotionOut[];
}

interface UseVotingStateResult {
  choices: Record<string, VoteChoice | null>;
  multiChoiceSelections: Record<string, OptionChoiceMap>;
  highlightUnanswered: boolean;
  setHighlightUnanswered: (v: boolean) => void;
  handleChoiceChange: (motionId: string, choice: VoteChoice | null) => void;
  handleMultiChoiceChange: (motionId: string, newChoices: OptionChoiceMap) => void;
  resetMultiChoiceSelections: () => void;
  answeredCount: number;
  unansweredMotions: MotionOut[];
}

export function loadFromSessionStorage(meetingId: string | undefined): Record<string, OptionChoiceMap> {
  if (!meetingId) return {};
  try {
    const raw = sessionStorage.getItem(`meeting_mc_selections_${meetingId}`);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, OptionChoiceMap>;
  } catch {
    return {};
  }
}

export function useVotingState({
  meetingId,
  motions,
  isMotionReadOnly,
  unvotedMotions,
}: UseVotingStateParams): UseVotingStateResult {
  const [choices, setChoices] = useState<Record<string, VoteChoice | null>>({});
  const [multiChoiceSelections, setMultiChoiceSelections] = useState<Record<string, OptionChoiceMap>>(
    () => loadFromSessionStorage(meetingId)
  );
  const [highlightUnanswered, setHighlightUnanswered] = useState(false);

  // Use refs to avoid triggering the seeding effect on prop reference changes.
  const isMotionReadOnlyRef = useRef(isMotionReadOnly);
  isMotionReadOnlyRef.current = isMotionReadOnly;

  // Memoize the motions array identity to prevent infinite effect loops when
  // callers pass a new array literal on every render.
  const motionsRef = useRef(motions);
  if (motions !== motionsRef.current) {
    motionsRef.current = motions;
  }

  // Seed choices and multiChoiceSelections from submitted_choice when motions load (revote scenario).
  // Returns prev unchanged when nothing is seeded to prevent unnecessary re-renders.
  useEffect(() => {
    const currentMotions = motionsRef.current;
    if (!currentMotions) return;
    const isReadOnly = isMotionReadOnlyRef.current;

    setChoices((prev) => {
      let changed = false;
      const seeded: Record<string, VoteChoice | null> = { ...prev };
      for (const m of currentMotions) {
        if (
          m.already_voted &&
          m.submitted_choice !== null &&
          !(m.id in seeded) &&
          isReadOnly(m)
        ) {
          seeded[m.id] = m.submitted_choice;
          changed = true;
        }
      }
      return changed ? seeded : prev;
    });

    setMultiChoiceSelections((prev) => {
      let changed = false;
      const seeded: Record<string, OptionChoiceMap> = { ...prev };
      for (const m of currentMotions) {
        if (
          m.is_multi_choice &&
          isReadOnly(m) &&
          m.submitted_option_choices &&
          Object.keys(m.submitted_option_choices).length > 0 &&
          !(m.id in seeded)
        ) {
          seeded[m.id] = m.submitted_option_choices as OptionChoiceMap;
          changed = true;
        }
      }
      return changed ? seeded : prev;
    });
  }, [motions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChoiceChange = (motionId: string, choice: VoteChoice | null) => {
    setChoices((prev) => ({ ...prev, [motionId]: choice }));
  };

  const handleMultiChoiceChange = (motionId: string, newChoices: OptionChoiceMap) => {
    setMultiChoiceSelections((prev) => {
      const next = { ...prev, [motionId]: newChoices };
      if (meetingId) {
        sessionStorage.setItem(`meeting_mc_selections_${meetingId}`, JSON.stringify(next));
      }
      return next;
    });
  };

  const resetMultiChoiceSelections = () => {
    setMultiChoiceSelections({});
    if (meetingId) {
      sessionStorage.removeItem(`meeting_mc_selections_${meetingId}`);
    }
  };

  const answeredCount = unvotedMotions.filter((m) =>
    m.is_multi_choice
      ? m.id in multiChoiceSelections
      : !!choices[m.id]
  ).length;

  const unansweredMotions = unvotedMotions.filter((m) =>
    m.is_multi_choice
      ? !(m.id in multiChoiceSelections)
      : !choices[m.id]
  );

  return {
    choices,
    multiChoiceSelections,
    highlightUnanswered,
    setHighlightUnanswered,
    handleChoiceChange,
    handleMultiChoiceChange,
    resetMultiChoiceSelections,
    answeredCount,
    unansweredMotions,
  };
}
