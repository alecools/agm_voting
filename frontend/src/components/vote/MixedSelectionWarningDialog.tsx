import type { LotInfo } from "../../api/voter";

interface MixedSelectionWarningDialogProps {
  differingLots: LotInfo[];
  onContinue: () => void;
  onGoBack: () => void;
}

export function MixedSelectionWarningDialog({
  differingLots,
  onContinue,
  onGoBack,
}: MixedSelectionWarningDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mixed-warning-dialog-title"
      className="dialog-overlay"
    >
      <div className="dialog">
        <div className="dialog__icon dialog__icon--warning">⚠</div>
        <h2 className="dialog__title" id="mixed-warning-dialog-title">
          Mixed voting history
        </h2>
        <p className="dialog__body">
          Some of your selected lots have already voted on earlier motions. Those
          previously submitted votes will not be changed — only new motions will be
          recorded for those lots.
        </p>
        <p className="dialog__body">
          Lots voting for the first time will record answers for all motions shown.
        </p>
        {differingLots.length > 0 && (
          <ul className="dialog__list">
            {differingLots.map((lot) => (
              <li className="dialog__list-item" key={lot.lot_owner_id}>
                Lot {lot.lot_number}
              </li>
            ))}
          </ul>
        )}
        <p className="dialog__body">Do you want to continue?</p>
        <div className="dialog__actions">
          <button type="button" className="btn btn--secondary" onClick={onGoBack}>
            Go back to lot selection
          </button>
          <button type="button" className="btn btn--primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
