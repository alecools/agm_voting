/**
 * AdminVoteEntryPanel — US-AVE-01/02
 *
 * Step 1: Select lots that haven't submitted via the app yet.
 * Step 2: Enter votes per motion for each selected lot.
 * On submit: POST /api/admin/general-meetings/{id}/enter-votes
 */
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  listLotOwners,
  enterInPersonVotes,
  type GeneralMeetingDetail,
  type MotionDetail,
  type AdminVoteEntryLot,
  type AdminVoteEntryItem,
  type AdminMultiChoiceVoteItem,
} from "../../api/admin";
import type { LotOwner } from "../../types";

interface AdminVoteEntryPanelProps {
  meeting: GeneralMeetingDetail;
  onClose: () => void;
  onSuccess: () => void;
}

type VoteChoice = "yes" | "no" | "abstained";

interface LotVotes {
  /** motion_id -> choice for binary motions */
  choices: Record<string, VoteChoice>;
  /** motion_id -> option_ids[] for multi-choice */
  multiChoiceSelections: Record<string, string[]>;
}

function initialLotVotes(): LotVotes {
  return { choices: {}, multiChoiceSelections: {} };
}

function isLotAnswered(lotVotes: LotVotes, visibleMotions: MotionDetail[]): boolean {
  return visibleMotions.every((m) => {
    if (m.is_multi_choice) {
      // multi-choice: any selection (including empty = abstain) counts as answered
      return true;
    }
    return m.id in lotVotes.choices;
  });
}

interface ConfirmDialogProps {
  lotCount: number;
  motionCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ lotCount, motionCount, onConfirm, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
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
        <h2 id="confirm-dialog-title" style={{ marginTop: 0, marginBottom: 12 }}>
          Submit in-person votes?
        </h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: 24 }}>
          Submitting votes for {lotCount} lot(s) across {motionCount} motion(s). This cannot be undone.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminVoteEntryPanel({ meeting, onClose, onSuccess }: AdminVoteEntryPanelProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedLotIds, setSelectedLotIds] = useState<Set<string>>(new Set());
  const [lotVotes, setLotVotes] = useState<Record<string, LotVotes>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const buildingId = meeting.building_id ?? "";

  const { data: allLotOwners = [], isLoading: lotsLoading } = useQuery<LotOwner[]>({
    queryKey: ["lot-owners", buildingId],
    queryFn: () => listLotOwners(buildingId),
    enabled: !!buildingId,
  });

  // Determine which lots are app-submitted (non-admin submission)
  // We derive this from the voter lists in the meeting detail
  const appSubmittedLotNumbers = new Set<string>();
  for (const motion of meeting.motions) {
    for (const cat of ["yes", "no", "abstained", "not_eligible"] as const) {
      for (const v of motion.voter_lists[cat]) {
        if (v.lot_number && !v.submitted_by_admin) {
          appSubmittedLotNumbers.add(v.lot_number);
        }
      }
    }
  }

  // Visible motions for vote entry grid
  const visibleMotions = meeting.motions.filter((m) => m.is_visible);

  const toggleLot = useCallback((lotId: string) => {
    setSelectedLotIds((prev) => {
      const next = new Set(prev);
      if (next.has(lotId)) {
        next.delete(lotId);
      } else {
        next.add(lotId);
      }
      return next;
    });
  }, []);

  const setChoice = useCallback((lotId: string, motionId: string, choice: VoteChoice) => {
    setLotVotes((prev) => {
      const existing = prev[lotId] ?? initialLotVotes();
      return {
        ...prev,
        [lotId]: {
          ...existing,
          choices: { ...existing.choices, [motionId]: choice },
        },
      };
    });
  }, []);

  const toggleMultiOption = useCallback(
    (lotId: string, motionId: string, optionId: string, optionLimit: number | null) => {
      setLotVotes((prev) => {
        const existing = prev[lotId] ?? initialLotVotes();
        const currentSelection = existing.multiChoiceSelections[motionId] ?? [];
        let next: string[];
        if (currentSelection.includes(optionId)) {
          next = currentSelection.filter((id) => id !== optionId);
        } else {
          if (optionLimit !== null && currentSelection.length >= optionLimit) {
            // at limit — do not add
            return prev;
          }
          next = [...currentSelection, optionId];
        }
        return {
          ...prev,
          [lotId]: {
            ...existing,
            multiChoiceSelections: { ...existing.multiChoiceSelections, [motionId]: next },
          },
        };
      });
    },
    []
  );

  const submitMutation = useMutation({
    mutationFn: (entries: AdminVoteEntryLot[]) =>
      enterInPersonVotes(meeting.id, { entries }),
    onSuccess: () => {
      setShowConfirm(false);
      onSuccess();
    },
    onError: (err: Error) => {
      setShowConfirm(false);
      setSubmitError(err.message || "Submission failed. Please try again.");
    },
  });

  function handleSubmit() {
    const selectedLotsArr = Array.from(selectedLotIds);
    const entries: AdminVoteEntryLot[] = selectedLotsArr.map((lotId) => {
      const votes_data = lotVotes[lotId] ?? initialLotVotes();
      const votes: AdminVoteEntryItem[] = visibleMotions
        .filter((m) => !m.is_multi_choice)
        .map((m) => ({
          motion_id: m.id,
          choice: votes_data.choices[m.id] ?? "abstained",
        }));
      const multi_choice_votes: AdminMultiChoiceVoteItem[] = visibleMotions
        .filter((m) => m.is_multi_choice === true)
        .map((m) => ({
          motion_id: m.id,
          option_ids: votes_data.multiChoiceSelections[m.id] ?? [],
        }));
      return { lot_owner_id: lotId, votes, multi_choice_votes };
    });
    submitMutation.mutate(entries);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !showConfirm && !submitMutation.isPending) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, showConfirm, submitMutation.isPending]);

  const selectedLotsArr = allLotOwners.filter(
    (lo) => selectedLotIds.has(lo.id)
  );

  // Step 1: lot selection
  if (step === 1) {
    const pendingLots = allLotOwners.filter(
      (lo) => !appSubmittedLotNumbers.has(lo.lot_number)
    );

    return (
      <>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enter In-Person Votes — Select Lots"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            zIndex: 1100,
            overflowY: "auto",
            paddingTop: 48,
            paddingBottom: 48,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div
            style={{
              background: "var(--white)",
              borderRadius: "var(--r-xl)",
              padding: 32,
              width: "100%",
              maxWidth: 560,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ margin: 0 }}>Enter In-Person Votes</h2>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onClose}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ color: "var(--text-secondary)", marginBottom: 20 }}>
              Select lot owners whose in-person votes you want to enter. Lots that have already submitted via the app are excluded.
            </p>

            {lotsLoading ? (
              <p className="state-message">Loading lots...</p>
            ) : pendingLots.length === 0 ? (
              <p className="state-message">All lots have already submitted via the app.</p>
            ) : (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-md)",
                  maxHeight: 360,
                  overflowY: "auto",
                  marginBottom: 24,
                }}
              >
                {pendingLots.map((lo) => (
                  <label
                    key={lo.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedLotIds.has(lo.id)}
                      onChange={() => toggleLot(lo.id)}
                      aria-label={`Select lot ${lo.lot_number}`}
                    />
                    <span style={{ fontWeight: 600 }}>Lot {lo.lot_number}</span>
                    {lo.financial_position === "in_arrear" && (
                      <span
                        style={{
                          fontSize: "0.7rem",
                          background: "var(--amber-bg)",
                          color: "var(--amber)",
                          borderRadius: "var(--r-sm)",
                          padding: "1px 6px",
                        }}
                      >
                        In arrear
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn btn--secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={selectedLotIds.size === 0}
                onClick={() => setStep(2)}
              >
                Proceed to vote entry ({selectedLotIds.size} lot{selectedLotIds.size !== 1 ? "s" : ""})
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Step 2: vote entry grid
  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          lotCount={selectedLotIds.size}
          motionCount={visibleMotions.length}
          onConfirm={handleSubmit}
          onCancel={() => setShowConfirm(false)}
        />
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Enter In-Person Votes — Vote Grid"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          zIndex: 1100,
          overflowY: "auto",
          padding: "48px 16px",
        }}
      >
        <div
          style={{
            background: "var(--white)",
            borderRadius: "var(--r-xl)",
            padding: 32,
            width: "100%",
            maxWidth: 900,
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <h2 style={{ margin: 0 }}>Enter Votes</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setStep(1)}
                disabled={submitMutation.isPending}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onClose}
                aria-label="Close"
                disabled={submitMutation.isPending}
              >
                ×
              </button>
            </div>
          </div>

          {submitError && (
            <div
              role="alert"
              style={{
                background: "var(--red-bg)",
                color: "var(--red)",
                borderRadius: "var(--r-md)",
                padding: "10px 16px",
                marginBottom: 20,
              }}
            >
              {submitError}
            </div>
          )}

          <div style={{ overflowX: "auto", marginBottom: 24 }}>
            <table className="admin-table" style={{ minWidth: 400 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>Motion</th>
                  {selectedLotsArr.map((lo) => {
                    const allAnswered = isLotAnswered(
                      lotVotes[lo.id] ?? initialLotVotes(),
                      visibleMotions
                    );
                    return (
                      <th key={lo.id} style={{ minWidth: 140, textAlign: "center" }}>
                        <div>Lot {lo.lot_number}</div>
                        {allAnswered && (
                          <span
                            style={{
                              display: "inline-block",
                              fontSize: "0.65rem",
                              background: "var(--green-bg)",
                              color: "var(--green)",
                              borderRadius: "var(--r-sm)",
                              padding: "1px 6px",
                              marginTop: 2,
                            }}
                          >
                            All answered
                          </span>
                        )}
                        {lo.financial_position === "in_arrear" && (
                          <span
                            style={{
                              display: "inline-block",
                              fontSize: "0.65rem",
                              background: "var(--amber-bg)",
                              color: "var(--amber)",
                              borderRadius: "var(--r-sm)",
                              padding: "1px 6px",
                              marginTop: 2,
                            }}
                          >
                            In arrear
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleMotions.map((motion) => (
                  <tr key={motion.id}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                        {motion.motion_number?.trim() || String(motion.display_order)}. {motion.title}
                      </div>
                      {motion.is_multi_choice === true && (
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          Multi-choice (limit: {motion.option_limit})
                        </div>
                      )}
                    </td>
                    {selectedLotsArr.map((lo) => {
                      const isInArrear = lo.financial_position === "in_arrear";
                      const votes_data = lotVotes[lo.id] ?? initialLotVotes();

                      // In-arrear lots: disabled for general/multi_choice, enabled for special
                      const isDisabled =
                        isInArrear &&
                        (motion.motion_type === "general" || motion.is_multi_choice === true);

                      if (isDisabled) {
                        return (
                          <td key={lo.id} style={{ textAlign: "center" }}>
                            <span
                              style={{
                                fontSize: "0.7rem",
                                color: "var(--text-muted)",
                                fontStyle: "italic",
                              }}
                            >
                              Not eligible
                            </span>
                          </td>
                        );
                      }

                      if (motion.is_multi_choice === true) {
                        const selected = votes_data.multiChoiceSelections[motion.id] ?? [];
                        const atLimit =
                          motion.option_limit !== null && selected.length >= motion.option_limit;

                        return (
                          <td key={lo.id} style={{ textAlign: "center" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                              {motion.options.map((opt) => {
                                const isChecked = selected.includes(opt.id);
                                const disableCheck = !isChecked && atLimit;
                                return (
                                  <label
                                    key={opt.id}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 4,
                                      fontSize: "0.8rem",
                                      cursor: disableCheck ? "not-allowed" : "pointer",
                                      color: disableCheck ? "var(--text-muted)" : undefined,
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      disabled={disableCheck}
                                      onChange={() =>
                                        toggleMultiOption(lo.id, motion.id, opt.id, motion.option_limit)
                                      }
                                      aria-label={`${opt.text} for lot ${lo.lot_number}`}
                                    />
                                    {opt.text}
                                  </label>
                                );
                              })}
                              <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>
                                {selected.length}/{motion.option_limit} selected
                              </div>
                            </div>
                          </td>
                        );
                      }

                      // Binary motion
                      const currentChoice = votes_data.choices[motion.id];
                      return (
                        <td key={lo.id} style={{ textAlign: "center" }}>
                          <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                            {(["yes", "no", "abstained"] as VoteChoice[]).map((choice) => (
                              <button
                                key={choice}
                                type="button"
                                onClick={() => setChoice(lo.id, motion.id, choice)}
                                aria-label={`${choice} for lot ${lo.lot_number} motion ${motion.title}`}
                                aria-pressed={currentChoice === choice}
                                style={{
                                  padding: "3px 8px",
                                  fontSize: "0.7rem",
                                  fontWeight: currentChoice === choice ? 700 : 400,
                                  borderRadius: "var(--r-sm)",
                                  border: "1px solid",
                                  cursor: "pointer",
                                  background:
                                    currentChoice === choice
                                      ? choice === "yes"
                                        ? "var(--green)"
                                        : choice === "no"
                                        ? "var(--red)"
                                        : "var(--text-muted)"
                                      : "var(--white)",
                                  color:
                                    currentChoice === choice
                                      ? "var(--white)"
                                      : choice === "yes"
                                      ? "var(--green)"
                                      : choice === "no"
                                      ? "var(--red)"
                                      : "var(--text-muted)",
                                  borderColor:
                                    choice === "yes"
                                      ? "var(--green)"
                                      : choice === "no"
                                      ? "var(--red)"
                                      : "var(--border)",
                                }}
                              >
                                {choice === "yes" ? "For" : choice === "no" ? "Against" : "Abstain"}
                              </button>
                            ))}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={submitMutation.isPending}
              onClick={() => { setSubmitError(null); setShowConfirm(true); }}
            >
              {submitMutation.isPending ? "Submitting..." : "Submit votes"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
