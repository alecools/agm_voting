interface SubmitDialogProps {
  unansweredMotions: { display_order: number; motion_number: string | null; title: string }[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function SubmitDialog({ unansweredMotions, onConfirm, onCancel }: SubmitDialogProps) {
  const hasUnanswered = unansweredMotions.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="submit-dialog-title"
      className="dialog-overlay"
    >
      <div className="dialog">
        <div className={`dialog__icon dialog__icon--${hasUnanswered ? "warning" : "confirm"}`}>
          {hasUnanswered ? "⚠" : "✓"}
        </div>
        <h2 className="dialog__title" id="submit-dialog-title">
          {hasUnanswered ? "Unanswered motions" : "Confirm submission"}
        </h2>
        {hasUnanswered ? (
          <>
            <p className="dialog__body">
              {unansweredMotions.length} motion{unansweredMotions.length !== 1 ? "s" : ""} are unanswered and will be recorded as <strong>Abstained</strong>.
            </p>
            <ul className="dialog__list">
              {unansweredMotions.map((m) => (
                <li className="dialog__list-item" key={m.display_order}>
                  Motion {m.motion_number?.trim() || m.display_order} — {m.title}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="dialog__body">
            Are you sure? Votes cannot be changed after submission.
          </p>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm}>
            Submit ballot
          </button>
        </div>
      </div>
    </div>
  );
}
