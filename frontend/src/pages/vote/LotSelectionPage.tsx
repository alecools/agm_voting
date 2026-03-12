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
 * The voter clicks "Start Voting" to proceed.
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

  const pendingLots = lots.filter((l) => !l.already_submitted);
  const allSubmitted = lots.length > 0 && lots.every((l) => l.already_submitted);

  const handleStartVoting = () => {
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
            : `You are voting for ${pendingLots.length} lot${pendingLots.length !== 1 ? "s" : ""}.`}
        </p>

        <ul className="lot-selection__list" role="list">
          {lots.map((lot) => (
            <li
              key={lot.lot_owner_id}
              className={`lot-selection__item${lot.already_submitted ? " lot-selection__item--submitted" : ""}`}
              aria-disabled={lot.already_submitted ? "true" : undefined}
            >
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
            className="btn btn--primary"
            onClick={handleStartVoting}
          >
            Start Voting
          </button>
        )}
      </div>
    </main>
  );
}
