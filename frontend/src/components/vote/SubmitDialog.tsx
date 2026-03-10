import React from "react";

interface SubmitDialogProps {
  unansweredTitles: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function SubmitDialog({ unansweredTitles, onConfirm, onCancel }: SubmitDialogProps) {
  const hasUnanswered = unansweredTitles.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="submit-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "8px",
          padding: "24px",
          maxWidth: "480px",
          width: "100%",
        }}
      >
        <h2 id="submit-dialog-title">
          {hasUnanswered ? "Unanswered motions" : "Confirm submission"}
        </h2>
        {hasUnanswered ? (
          <>
            <p>
              The following motions have no answer and will be recorded as{" "}
              <strong>Abstained</strong>. Confirm submission?
            </p>
            <ul>
              {unansweredTitles.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>Are you sure? Votes cannot be changed after submission.</p>
        )}
        <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
