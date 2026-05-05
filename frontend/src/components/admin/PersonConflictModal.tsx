import { useEffect } from "react";

interface PersonConflictModalProps {
  email: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function PersonConflictModal({
  email,
  onConfirm,
  onCancel,
}: PersonConflictModalProps) {
  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
    >
      <div className="dialog" style={{ maxWidth: 440 }}>
        <h3
          id="conflict-modal-title"
          className="admin-card__title"
          style={{ marginBottom: 16 }}
        >
          Update person details?
        </h3>
        <p style={{ fontSize: "0.875rem", marginBottom: 20, color: "var(--text-secondary)" }}>
          The name or phone number you entered is different from the existing
          record for <strong>{email}</strong>. Updating will apply to all lots
          and proxies linked to this person. Do you want to continue?
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onConfirm}
          >
            Update and save
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
