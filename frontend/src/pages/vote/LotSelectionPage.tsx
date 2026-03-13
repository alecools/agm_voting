import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { LotInfo } from "../../api/voter";

/**
 * LotSelectionPage
 *
 * Shown after authentication when the voter has one or more lots (own or proxied).
 * Displays the list from sessionStorage, shows "Proxy" badge for proxied lots,
 * and "In Arrear" badge for lots with in_arrear financial position.
 * Already-submitted lots are shown greyed out and non-interactive.
 *
 * Multi-lot voters see checkboxes and can select which lots to vote for in this
 * session. All pending lots are checked by default. Single-lot voters see no
 * checkboxes — the existing UX is preserved unchanged.
 *
 * On "Start Voting", the selected lot_owner_ids are written to
 * sessionStorage['meeting_lots_${meetingId}'] and navigation proceeds.
 */
export function LotSelectionPage() {
  const { meetingId } = useParams<{ meetingId: string }>();
  const navigate = useNavigate();

  // Load lots stored by AuthPage after successful auth
  const lots: LotInfo[] = React.useMemo(() => {
    const raw = sessionStorage.getItem(`meeting_lots_info_${meetingId}`);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as LotInfo[];
    } catch {
      return [];
    }
  }, [meetingId]);

  const isMultiLot = lots.length > 1;

  // Initialise selectedIds to all pending lot IDs
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => {
    const pending = lots
      .filter((l) => !l.already_submitted)
      .map((l) => l.lot_owner_id);
    return new Set(pending);
  });

  const [showNoSelectionError, setShowNoSelectionError] = React.useState(false);

  const allSubmitted = lots.length > 0 && lots.every((l) => l.already_submitted);

  // For the subtitle: single-lot shows fixed pending count; multi-lot shows dynamic selected count
  const pendingLots = lots.filter((l) => !l.already_submitted);
  const votingCount = isMultiLot ? selectedIds.size : pendingLots.length;

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
    // Clear the error as soon as the user interacts
    setShowNoSelectionError(false);
  };

  const handleStartVoting = () => {
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
    navigate(`/vote/${meetingId}/voting`);
  };

  const handleViewSubmission = () => {
    navigate(`/vote/${meetingId}/confirmation`);
  };

  return (
    <main className="voter-content">
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}`)}>
        ← Back
      </button>
      <div className="lot-selection">
        <h1 className="lot-selection__title">Your Lots</h1>
        <p className="lot-selection__subtitle">
          {allSubmitted
            ? "All lots have been submitted."
            : `You are voting for ${votingCount} lot${votingCount !== 1 ? "s" : ""}.`}
        </p>

        <ul className="lot-selection__list" role="list">
          {lots.map((lot) => (
            <li
              key={lot.lot_owner_id}
              className={`lot-selection__item${lot.already_submitted ? " lot-selection__item--submitted" : ""}`}
              aria-disabled={lot.already_submitted ? "true" : undefined}
            >
              {isMultiLot && (
                <input
                  type="checkbox"
                  id={`lot-checkbox-${lot.lot_owner_id}`}
                  className="lot-selection__checkbox"
                  checked={selectedIds.has(lot.lot_owner_id)}
                  disabled={lot.already_submitted}
                  onChange={() => handleToggle(lot.lot_owner_id)}
                  aria-label={`Select Lot ${lot.lot_number}`}
                />
              )}

              <span className="lot-selection__lot-number">Lot {lot.lot_number}</span>

              {lot.is_proxy && (
                <span className="lot-selection__badge lot-selection__badge--proxy">
                  Proxy for Lot {lot.lot_number}
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

        {allSubmitted ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleViewSubmission}
          >
            View Submission
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn--primary${isMultiLot && selectedIds.size === 0 ? " btn--disabled" : ""}`}
            aria-disabled={isMultiLot && selectedIds.size === 0 ? "true" : undefined}
            onClick={handleStartVoting}
          >
            Start Voting
          </button>
        )}
      </div>
    </main>
  );
}
