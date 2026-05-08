import type React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { submitBallot } from "../api/voter";
import type { LotInfo } from "../api/voter";
import type { MotionOut } from "../api/voter";
import type { VoteChoice } from "../types";
import { optionChoiceMapToRequest } from "../components/vote/MultiChoiceOptionList";
import type { OptionChoiceMap } from "./useVotingState";

interface SubmitCallbacks {
  setAllLots: React.Dispatch<React.SetStateAction<LotInfo[]>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  resetMultiChoiceSelections: () => void;
  setIsClosed: (v: boolean) => void;
  setShowDialog: (v: boolean) => void;
}

interface UseMotionSubmissionParams {
  meetingId: string | undefined;
  motions: MotionOut[] | undefined;
  isMultiLot: boolean;
  selectedIds: Set<string>;
  allLots: LotInfo[];
  isMotionReadOnly: (m: { id: string }) => boolean;
  callbacks: SubmitCallbacks;
}

interface UseMotionSubmissionResult {
  isPending: boolean;
  handleConfirm: (params: {
    choices: Record<string, VoteChoice | null>;
    multiChoiceSelections: Record<string, OptionChoiceMap>;
  }) => void;
  handleCancel: () => void;
}

export function useMotionSubmission({
  meetingId,
  motions,
  isMultiLot,
  selectedIds,
  allLots,
  isMotionReadOnly,
  callbacks,
}: UseMotionSubmissionParams): UseMotionSubmissionResult {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const submitMutation = useMutation({
    mutationFn: ({
      lotsToSubmit,
      votes,
      multiChoiceVotes,
    }: {
      lotsToSubmit: string[];
      votes: { motion_id: string; choice: VoteChoice }[];
      multiChoiceVotes: { motion_id: string; option_choices: { option_id: string; choice: "for" | "against" | "abstained" }[] }[];
    }) =>
      submitBallot(meetingId!, {
        lot_owner_ids: lotsToSubmit,
        votes,
        multi_choice_votes: multiChoiceVotes.map(({ motion_id, option_choices }) => ({
          motion_id,
          option_choices,
        })),
      }),
    onSuccess: (_data, variables) => {
      const submittedIds = variables.lotsToSubmit;
      const submittedSet = new Set(submittedIds);
      const currentMotionIds = motions ? motions.map((m) => m.id) : [];

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
          // ignore parse errors
        }
      }

      callbacks.setAllLots((prev) =>
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

      callbacks.setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of submittedSet) next.delete(id);
        return next;
      });

      callbacks.resetMultiChoiceSelections();

      navigate(`/vote/${meetingId}/confirmation`);

      // Invalidate after navigation so the refetch does not race with VotingPage unmounting.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["voting-init", meetingId] });
      }, 0);
    },
    onError: (error: Error) => {
      if (error.message.includes("409")) {
        navigate(`/vote/${meetingId}/confirmation`);
      } else if (error.message.includes("403")) {
        callbacks.setIsClosed(true);
        callbacks.setShowDialog(false);
      }
    },
  });

  const handleConfirm = ({
    choices,
    multiChoiceSelections,
  }: {
    choices: Record<string, VoteChoice | null>;
    multiChoiceSelections: Record<string, OptionChoiceMap>;
  }) => {
    callbacks.setShowDialog(false);
    const lotsToSubmit = isMultiLot ? [...selectedIds] : allLots.map((l) => l.lot_owner_id);
    const votes = Object.entries(choices)
      .filter(([, choice]) => choice !== null && choice !== "selected")
      .filter(([motion_id]) => {
        const motion = motions?.find((m) => m.id === motion_id);
        return !motion || !isMotionReadOnly(motion);
      })
      .map(([motion_id, choice]) => ({ motion_id, choice: choice as VoteChoice }));
    const multiChoiceVotes = Object.entries(multiChoiceSelections)
      .filter(([motion_id]) => {
        const motion = motions?.find((m) => m.id === motion_id);
        return !motion || !isMotionReadOnly(motion);
      })
      .map(([motion_id, optChoices]) => ({
        motion_id,
        option_choices: optionChoiceMapToRequest(optChoices),
      }));
    submitMutation.mutate({ lotsToSubmit, votes, multiChoiceVotes });
  };

  const handleCancel = () => {
    callbacks.setShowDialog(false);
  };

  return {
    isPending: submitMutation.isPending,
    handleConfirm,
    handleCancel,
  };
}
