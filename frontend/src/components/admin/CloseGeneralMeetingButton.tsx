import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { closeGeneralMeeting } from "../../api/admin";
import type { GeneralMeetingCloseOut } from "../../api/admin";

interface CloseGeneralMeetingButtonProps {
  meetingId: string;
  meetingTitle: string;
  onSuccess: () => void;
}

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function CloseGeneralMeetingButton({ meetingId, meetingTitle, onSuccess }: CloseGeneralMeetingButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation<GeneralMeetingCloseOut, Error, string>({
    mutationFn: (id) => closeGeneralMeeting(id),
    onSuccess: () => {
      setShowDialog(false);
      setError(null);
      onSuccess();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  // Focus trap: move focus into dialog when it opens; restore on close
  useEffect(() => {
    if (!showDialog) return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (focusable && focusable.length > 0) {
      focusable[0].focus();
    }
    return () => {
      triggerRef.current?.focus();
    };
  }, [showDialog]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS);
    if (!focusable || focusable.length === 0) return;
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

  function handleConfirm() {
    mutation.mutate(meetingId);
  }

  return (
    <>
      <button ref={triggerRef} className="btn btn--danger" onClick={() => setShowDialog(true)}>
        Close Voting
      </button>

      {showDialog && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-meeting-title"
          ref={dialogRef}
          onKeyDown={handleKeyDown}
        >
          <div className="dialog">
            <div className="dialog__icon dialog__icon--warning">⚠</div>
            <h2 className="dialog__title" id="close-meeting-title">Close Voting</h2>
            <p className="dialog__body">
              Close voting for <strong>{meetingTitle}</strong>? This cannot be undone.
              Results will be emailed to all lot owners.
            </p>
            {error && (
              <p style={{ color: "var(--red)", fontSize: "0.875rem", marginBottom: 12 }}>{error}</p>
            )}
            <div className="dialog__actions">
              <button
                className="btn btn--secondary"
                onClick={() => { setShowDialog(false); setError(null); }}
                disabled={mutation.isPending}
              >
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={handleConfirm}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Closing..." : "Confirm Close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
