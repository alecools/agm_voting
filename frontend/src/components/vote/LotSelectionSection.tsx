/**
 * LotSelectionSection — extracted from VotingPage (US-CQM-03).
 *
 * Renders the lot list panel used in the desktop sidebar, mobile drawer, and
 * the inline single-proxy-lot strip. Fully controlled: all state is owned by
 * VotingPage and passed down as props.
 */
import type { LotInfo } from "../../api/voter";

interface LotSelectionSectionProps {
  allLots: LotInfo[];
  selectedIds: Set<string>;
  allSubmitted: boolean;
  anySubmitted: boolean;
  votingCount: number;
  hasProxyLot: boolean;
  showNoSelectionError: boolean;
  isLotSubmitted: (lot: LotInfo) => boolean;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onSelectProxy: () => void;
  onSelectOwned: () => void;
  onViewSubmission: () => void;
}

export function LotSelectionSection({
  allLots,
  selectedIds,
  allSubmitted,
  anySubmitted,
  votingCount,
  hasProxyLot,
  showNoSelectionError,
  isLotSubmitted,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onSelectProxy,
  onSelectOwned,
  onViewSubmission,
}: LotSelectionSectionProps) {
  return (
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
          onClick={onSelectAll}
          aria-label="Select all lots"
        >
          Select All
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onDeselectAll}
          aria-label="Deselect all lots"
        >
          Deselect All
        </button>
        {hasProxyLot && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onSelectProxy}
            aria-label="Select proxy lots only"
          >
            Select Proxy Lots
          </button>
        )}
        {hasProxyLot && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onSelectOwned}
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
            className={`lot-selection__item${isLotSubmitted(lot) ? " lot-selection__item--submitted" : ""}`}
            aria-disabled={isLotSubmitted(lot) ? "true" : undefined}
          >
            <label
              htmlFor={`lot-checkbox-${lot.lot_owner_id}`}
              className="lot-selection__label"
            >
              <input
                type="checkbox"
                id={`lot-checkbox-${lot.lot_owner_id}`}
                className="lot-selection__checkbox"
                checked={selectedIds.has(lot.lot_owner_id)}
                disabled={isLotSubmitted(lot)}
                onChange={() => onToggle(lot.lot_owner_id)}
              />
              <span className="lot-selection__lot-number">Lot {lot.lot_number}</span>
            </label>

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

            {isLotSubmitted(lot) && (
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

      {anySubmitted && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={onViewSubmission}
        >
          View Submission
        </button>
      )}
    </div>
  );
}
