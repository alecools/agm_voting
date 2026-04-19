/**
 * AdminVoteEntryPanel — US-AVE-01/02
 *
 * Step 1: Select lots that haven't submitted via the app yet.
 * Step 2: Enter votes per motion for each selected lot.
 * On submit: POST /api/admin/general-meetings/{id}/enter-votes
 */
import { useState, useEffect, useCallback, useRef, memo, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  listLotOwners,
  enterInPersonVotes,
  type GeneralMeetingDetail,
  type MotionDetail,
  type AdminVoteEntryLot,
  type AdminVoteEntryItem,
  type AdminMultiChoiceVoteItem,
  type AdminMultiChoiceOptionChoice,
} from "../../api/admin";
import type { LotOwner } from "../../types";

interface AdminVoteEntryPanelProps {
  meeting: GeneralMeetingDetail;
  onClose: () => void;
  onSuccess: () => void;
}

type VoteChoice = "yes" | "no" | "abstained";
type OptionChoice = "for" | "against" | "abstained";

interface LotVotes {
  /** motion_id -> choice for binary motions */
  choices: Record<string, VoteChoice>;
  /**
   * US-AVE2-01: motion_id -> option_id -> "for"|"against"|"abstained"
   * Null/missing = blank (no choice made for that option)
   */
  multiChoiceChoices: Record<string, Record<string, OptionChoice>>;
}

function initialLotVotes(): LotVotes {
  return { choices: {}, multiChoiceChoices: {} };
}

function isLotAnswered(lotVotes: LotVotes, visibleMotions: MotionDetail[]): boolean {
  return visibleMotions.every((m) => {
    if (m.is_multi_choice) {
      // Fix 7: answered only when the admin has explicitly interacted with this motion
      // (i.e. at least one option has a choice set)
      const motionChoices = lotVotes.multiChoiceChoices[m.id];
      return motionChoices !== undefined && Object.keys(motionChoices).length > 0;
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
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // RR4-15: initial focus on Cancel (safer default for destructive confirmation)
  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      // RR4-15: focus trap — cycle Tab/Shift+Tab within the dialog
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      ref={dialogRef}
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
          <button ref={cancelButtonRef} type="button" className="btn btn--secondary" onClick={onCancel}>
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

// Fix 5: AdminRevoteWarningDialog — shown before submit when admin-submitted lots are selected
interface AdminRevoteWarningDialogProps {
  adminSubmittedLotNumbers: string[];
  totalSelectedCount: number;
  onContinue: () => void;
  onCancel: () => void;
}

function AdminRevoteWarningDialog({
  adminSubmittedLotNumbers,
  totalSelectedCount,
  onContinue,
  onCancel,
}: AdminRevoteWarningDialogProps) {
  const goBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Initial focus on "Go back" (safer default)
  useEffect(() => {
    goBackButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const nonAdminCount = totalSelectedCount - adminSubmittedLotNumbers.length;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="revote-warning-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1300,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: "var(--white)",
          borderRadius: "var(--r-lg)",
          padding: 32,
          minWidth: 360,
          maxWidth: 520,
          width: "100%",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 id="revote-warning-dialog-title" style={{ marginTop: 0, marginBottom: 12 }}>
          Some lots have already been entered
        </h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: 12 }}>
          The following lot(s) already have admin-entered votes and cannot be overwritten. They will be skipped when you submit — their existing votes will remain unchanged.
        </p>
        <ul style={{ marginBottom: 16, paddingLeft: 20 }}>
          {adminSubmittedLotNumbers.map((lotNum) => (
            <li key={lotNum} style={{ color: "var(--text-primary)", marginBottom: 4 }}>
              Lot {lotNum}
            </li>
          ))}
        </ul>
        {nonAdminCount > 0 && (
          <p style={{ color: "var(--text-secondary)", marginBottom: 24 }}>
            Lots without prior entries will be submitted normally.
          </p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button ref={goBackButtonRef} type="button" className="btn btn--secondary" onClick={onCancel}>
            Go back
          </button>
          <button type="button" className="btn btn--primary" onClick={onContinue}>
            Continue anyway
          </button>
        </div>
      </div>
    </div>
  );
}

// RR4-11: Memoized per-lot binary vote cell so only the affected lot re-renders
// when a vote choice changes.
interface LotBinaryVoteCellProps {
  lotId: string;
  lotNumber: string;
  motionId: string;
  motionTitle: string;
  currentChoice: VoteChoice | undefined;
  onSetChoice: (lotId: string, motionId: string, choice: VoteChoice) => void;
  isPriorEntry: boolean;
}

const LotBinaryVoteCell = memo(function LotBinaryVoteCell({
  lotId,
  lotNumber,
  motionId,
  motionTitle,
  currentChoice,
  onSetChoice,
  isPriorEntry,
}: LotBinaryVoteCellProps) {
  return (
    <td key={lotId} style={{ textAlign: "center" }}>
      {isPriorEntry && (
        <div
          style={{
            fontSize: "0.65rem",
            color: "var(--text-muted)",
            fontStyle: "italic",
            marginBottom: 4,
          }}
        >
          Prev. entry
        </div>
      )}
      <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
        {(["yes", "no", "abstained"] as VoteChoice[]).map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => onSetChoice(lotId, motionId, choice)}
            aria-label={`${choice} for lot ${lotNumber} motion ${motionTitle}`}
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
});

export default function AdminVoteEntryPanel({ meeting, onClose, onSuccess }: AdminVoteEntryPanelProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedLotIds, setSelectedLotIds] = useState<Set<string>>(new Set());
  const [lotVotes, setLotVotes] = useState<Record<string, LotVotes>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const [showRevoteWarning, setShowRevoteWarning] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{ submitted_count: number; skipped_count: number } | null>(null);

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

  // Fix 5: Determine which lots are admin-submitted
  const adminSubmittedLotNumbers = useMemo(() => {
    const result = new Set<string>();
    for (const motion of meeting.motions) {
      for (const cat of ["yes", "no", "abstained", "not_eligible"] as const) {
        for (const v of motion.voter_lists[cat]) {
          if (v.lot_number && v.submitted_by_admin) {
            result.add(v.lot_number);
          }
        }
      }
    }
    return result;
  }, [meeting.motions]);

  // Fix 5: Build a map from lot_owner_id -> prior LotVotes for admin-submitted lots
  const priorVotesByLotId = useMemo(() => {
    const lotNumberToId = new Map<string, string>();
    for (const lo of allLotOwners) {
      lotNumberToId.set(lo.lot_number, lo.id);
    }

    const result: Record<string, LotVotes> = {};

    for (const motion of meeting.motions) {
      if (!motion.is_visible) continue;

      if (motion.is_multi_choice) {
        // Multi-choice: build per-option prior choices
        const optionCategories: Array<{ key: "options_for" | "options_against" | "options_abstained"; choice: OptionChoice }> = [
          { key: "options_for", choice: "for" },
          { key: "options_against", choice: "against" },
          { key: "options_abstained", choice: "abstained" },
        ];
        for (const { key, choice } of optionCategories) {
          const optionMap = motion.voter_lists[key] ?? {};
          for (const [optionId, voters] of Object.entries(optionMap)) {
            for (const v of voters) {
              if (v.lot_number && v.submitted_by_admin) {
                const lotId = lotNumberToId.get(v.lot_number);
                if (lotId) {
                  if (!result[lotId]) result[lotId] = initialLotVotes();
                  if (!result[lotId].multiChoiceChoices[motion.id]) {
                    result[lotId].multiChoiceChoices[motion.id] = {};
                  }
                  result[lotId].multiChoiceChoices[motion.id][optionId] = choice;
                }
              }
            }
          }
        }
      } else {
        // Binary motion: check yes/no/abstained/not_eligible categories
        const binaryCategories: Array<{ cat: "yes" | "no" | "abstained" | "not_eligible"; choice: VoteChoice }> = [
          { cat: "yes", choice: "yes" },
          { cat: "no", choice: "no" },
          { cat: "abstained", choice: "abstained" },
        ];
        for (const { cat, choice } of binaryCategories) {
          for (const v of motion.voter_lists[cat]) {
            if (v.lot_number && v.submitted_by_admin) {
              const lotId = lotNumberToId.get(v.lot_number);
              if (lotId) {
                if (!result[lotId]) result[lotId] = initialLotVotes();
                result[lotId].choices[motion.id] = choice;
              }
            }
          }
        }
      }
    }

    return result;
  }, [meeting.motions, allLotOwners]);

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

  /**
   * US-AVE2-01: Set For/Against/Abstain for a single option within a multi-choice motion.
   * Clicking the same button a second time clears the selection (toggles off).
   */
  const setOptionChoice = useCallback(
    (lotId: string, motionId: string, optionId: string, choice: OptionChoice) => {
      setLotVotes((prev) => {
        const existing = prev[lotId] ?? initialLotVotes();
        const motionChoices = existing.multiChoiceChoices[motionId] ?? {};
        const currentChoice = motionChoices[optionId];
        // Toggle off if clicking the same button
        const nextMotionChoices =
          currentChoice === choice
            ? (({ [optionId]: _, ...rest }) => rest)(motionChoices)
            : { ...motionChoices, [optionId]: choice };
        return {
          ...prev,
          [lotId]: {
            ...existing,
            multiChoiceChoices: {
              ...existing.multiChoiceChoices,
              [motionId]: nextMotionChoices,
            },
          },
        };
      });
    },
    []
  );

  const submitMutation = useMutation({
    mutationFn: (entries: AdminVoteEntryLot[]) =>
      enterInPersonVotes(meeting.id, { entries }),
    onSuccess: (result) => {
      setShowConfirm(false);
      // Fix 5: if any lots were skipped, stay open and show a banner; otherwise close immediately
      if (result.skipped_count > 0) {
        setSubmitResult(result);
      } else {
        onSuccess();
      }
    },
    onError: (err: Error) => {
      setShowConfirm(false);
      // Fix 8: surface a clear message when a lot was already submitted (409)
      const is409 = err.message.includes("409") || err.message.toLowerCase().includes("already submitted");
      if (is409) {
        setSubmitError(
          "One or more selected lots already have a submitted ballot. Go back to step 1 and deselect those lots."
        );
      } else {
        setSubmitError(err.message || "Submission failed. Please try again.");
      }
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
      // US-AVE2-01: build option_choices from non-null per-option selections only
      const multi_choice_votes: AdminMultiChoiceVoteItem[] = visibleMotions
        .filter((m) => m.is_multi_choice === true)
        .map((m) => {
          const motionChoices = votes_data.multiChoiceChoices[m.id] ?? {};
          const option_choices: AdminMultiChoiceOptionChoice[] = Object.entries(motionChoices).map(
            ([optionId, choice]) => ({ option_id: optionId, choice })
          );
          return { motion_id: m.id, option_choices };
        });
      return { lot_owner_id: lotId, votes, multi_choice_votes };
    });
    submitMutation.mutate(entries);
  }

  // Fix 5: Handle submit button click — check for admin-submitted lots first
  function handleSubmitClick() {
    setSubmitError(null);
    const selectedLotsArr = allLotOwners.filter((lo) => selectedLotIds.has(lo.id));
    const hasAdminSubmitted = selectedLotsArr.some((lo) =>
      adminSubmittedLotNumbers.has(lo.lot_number)
    );
    if (hasAdminSubmitted) {
      setShowRevoteWarning(true);
    } else {
      setShowConfirm(true);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !showConfirm && !showRevoteWarning && !submitMutation.isPending) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, showConfirm, showRevoteWarning, submitMutation.isPending]);

  const selectedLotsArr = allLotOwners.filter(
    (lo) => selectedLotIds.has(lo.id)
  );

  // Fix 5: get the list of admin-submitted lot numbers among the currently selected lots
  const selectedAdminSubmittedLotNumbers = selectedLotsArr
    .filter((lo) => adminSubmittedLotNumbers.has(lo.lot_number))
    .map((lo) => lo.lot_number);

  // Step 1: lot selection
  if (step === 1) {
    const allSubmitted = allLotOwners.every((lo) => appSubmittedLotNumbers.has(lo.lot_number));

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
              Select lot owners whose in-person votes you want to enter. Lots already submitted via the app are shown but cannot be selected.
            </p>

            {lotsLoading ? (
              <p className="state-message">Loading lots...</p>
            ) : allSubmitted ? (
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
                {allLotOwners.map((lo) => {
                  const isAppSubmitted = appSubmittedLotNumbers.has(lo.lot_number);
                  return (
                    <li
                      key={lo.id}
                      aria-disabled={isAppSubmitted ? "true" : undefined}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 16px",
                        borderBottom: "1px solid var(--border-subtle)",
                        listStyle: "none",
                        opacity: isAppSubmitted ? 0.65 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedLotIds.has(lo.id)}
                        onChange={() => toggleLot(lo.id)}
                        disabled={isAppSubmitted}
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
                      {/* Badge for app-submitted lots */}
                      {isAppSubmitted && (
                        <span className="lot-selection__badge lot-selection__badge--submitted">
                          Already submitted
                        </span>
                      )}
                      {/* Fix 5: badge for admin-submitted lots */}
                      {!isAppSubmitted && adminSubmittedLotNumbers.has(lo.lot_number) && (
                        <span
                          style={{
                            fontSize: "0.7rem",
                            background: "var(--amber-bg)",
                            color: "var(--amber)",
                            borderRadius: "var(--r-sm)",
                            padding: "1px 6px",
                          }}
                        >
                          Previously entered by admin
                        </span>
                      )}
                    </li>
                  );
                })}
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
                onClick={() => {
                  // Fix 5: seed lotVotes with prior admin choices on step transition
                  setLotVotes((prev) => {
                    const next = { ...prev };
                    for (const lotId of Array.from(selectedLotIds)) {
                      const prior = priorVotesByLotId[lotId];
                      if (prior && !next[lotId]) {
                        next[lotId] = prior;
                      }
                    }
                    return next;
                  });
                  setStep(2);
                }}
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
      {showRevoteWarning && (
        <AdminRevoteWarningDialog
          adminSubmittedLotNumbers={selectedAdminSubmittedLotNumbers}
          totalSelectedCount={selectedLotIds.size}
          onContinue={() => {
            setShowRevoteWarning(false);
            setShowConfirm(true);
          }}
          onCancel={() => setShowRevoteWarning(false)}
        />
      )}
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

          {/* Fix 5: skipped_count banner shown when backend skips lots */}
          {submitResult && submitResult.skipped_count > 0 && (
            <div
              role="alert"
              style={{
                background: "var(--amber-bg)",
                color: "var(--amber)",
                borderRadius: "var(--r-md)",
                padding: "10px 16px",
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span>
                {submitResult.skipped_count} lot(s) were skipped (already had entries).{" "}
                {submitResult.submitted_count} lot(s) were submitted successfully.
              </span>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={onSuccess}
              >
                Done
              </button>
            </div>
          )}

          <div style={{ overflowX: "auto", marginBottom: 24 }}>
            <table className="admin-table" style={{ minWidth: 400 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ minWidth: 200 }}>Motion</th>
                  {selectedLotsArr.map((lo) => {
                    const allAnswered = isLotAnswered(
                      lotVotes[lo.id] ?? initialLotVotes(),
                      visibleMotions
                    );
                    const isAdminSubmitted = adminSubmittedLotNumbers.has(lo.lot_number);
                    return (
                      <th key={lo.id} scope="col" style={{ minWidth: 140, textAlign: "center" }}>
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
                        {/* Fix 8: pre-flight warning for already-submitted lots */}
                        {appSubmittedLotNumbers.has(lo.lot_number) && (
                          <span
                            style={{
                              display: "inline-block",
                              fontSize: "0.65rem",
                              background: "var(--red-bg)",
                              color: "var(--red)",
                              borderRadius: "var(--r-sm)",
                              padding: "1px 6px",
                              marginTop: 2,
                            }}
                          >
                            Already submitted
                          </span>
                        )}
                        {/* Fix 5: badge for admin-submitted lots in column header */}
                        {isAdminSubmitted && (
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
                            Previously entered by admin
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
                      const isAdminSubmitted = adminSubmittedLotNumbers.has(lo.lot_number);

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
                        // US-AVE2-01: per-option For/Against/Abstain buttons
                        const motionChoices = votes_data.multiChoiceChoices[motion.id] ?? {};
                        const forCount = Object.values(motionChoices).filter((c) => c === "for").length;
                        // Fix 1: mirror voter-side limitReached guard — block "For" when limit reached
                        const limitReached = motion.option_limit != null && forCount >= motion.option_limit;

                        return (
                          <td key={lo.id} style={{ verticalAlign: "top", padding: "8px" }}>
                            {/* Fix 5: "Prev. entry" label for admin-submitted lots */}
                            {isAdminSubmitted && (
                              <div
                                style={{
                                  fontSize: "0.65rem",
                                  color: "var(--text-muted)",
                                  fontStyle: "italic",
                                  marginBottom: 4,
                                }}
                              >
                                Prev. entry
                              </div>
                            )}
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {motion.options.map((opt) => {
                                const currentChoice = motionChoices[opt.id] ?? null;
                                return (
                                  <div key={opt.id}>
                                    <div
                                      style={{
                                        fontSize: "0.72rem",
                                        color: "var(--text-secondary)",
                                        marginBottom: 2,
                                      }}
                                    >
                                      {opt.text}
                                    </div>
                                    <div style={{ display: "flex", gap: 3 }}>
                                      {(["for", "against", "abstained"] as OptionChoice[]).map((choice) => {
                                        const isActive = currentChoice === choice;
                                        // Fix 1: disable "For" when limit reached and not already selected For
                                        const isForDisabled = choice === "for" && limitReached && currentChoice !== "for";
                                        const ariaLabel = isForDisabled
                                          ? `For option ${opt.text} lot ${lo.lot_number} (limit reached)`
                                          : `${choice === "for" ? "For" : choice === "against" ? "Against" : "Abstain"} option ${opt.text} lot ${lo.lot_number}`;
                                        return (
                                          <button
                                            key={choice}
                                            type="button"
                                            disabled={isForDisabled}
                                            onClick={() =>
                                              setOptionChoice(lo.id, motion.id, opt.id, choice)
                                            }
                                            aria-label={ariaLabel}
                                            aria-pressed={isActive}
                                            style={{
                                              padding: "2px 6px",
                                              fontSize: "0.65rem",
                                              fontWeight: isActive ? 700 : 400,
                                              borderRadius: "var(--r-sm)",
                                              border: "1px solid",
                                              cursor: isForDisabled ? "not-allowed" : "pointer",
                                              opacity: isForDisabled ? 0.4 : 1,
                                              background: isActive
                                                ? choice === "for"
                                                  ? "var(--green)"
                                                  : choice === "against"
                                                  ? "var(--red)"
                                                  : "var(--text-muted)"
                                                : "var(--white)",
                                              color: isActive
                                                ? "var(--white)"
                                                : choice === "for"
                                                ? "var(--green)"
                                                : choice === "against"
                                                ? "var(--red)"
                                                : "var(--text-muted)",
                                              borderColor:
                                                choice === "for"
                                                  ? "var(--green)"
                                                  : choice === "against"
                                                  ? "var(--red)"
                                                  : "var(--border)",
                                            }}
                                          >
                                            {choice === "for"
                                              ? "For"
                                              : choice === "against"
                                              ? "Against"
                                              : "Abstain"}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                              <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>
                                {forCount} of {motion.option_limit} voted For
                              </div>
                            </div>
                          </td>
                        );
                      }

                      // Binary motion — use memoized LotBinaryVoteCell (RR4-11)
                      const currentChoice = votes_data.choices[motion.id];
                      return (
                        <LotBinaryVoteCell
                          key={lo.id}
                          lotId={lo.id}
                          lotNumber={lo.lot_number}
                          motionId={motion.id}
                          motionTitle={motion.title}
                          currentChoice={currentChoice}
                          onSetChoice={setChoice}
                          isPriorEntry={isAdminSubmitted}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!submitResult && (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={submitMutation.isPending}
                onClick={handleSubmitClick}
              >
                {submitMutation.isPending ? "Submitting..." : "Submit votes"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
