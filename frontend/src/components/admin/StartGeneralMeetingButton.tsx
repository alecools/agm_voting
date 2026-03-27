import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { startGeneralMeeting } from "../../api/admin";
import type { GeneralMeetingStartOut } from "../../api/admin";

interface StartGeneralMeetingButtonProps {
  meetingId: string;
  onSuccess: () => void;
}

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function StartGeneralMeetingButton({ meetingId, onSuccess }: StartGeneralMeetingButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation<GeneralMeetingStartOut, Error, string>({
    mutationFn: (id) => startGeneralMeeting(id),
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
      <button ref={triggerRef} className="btn btn--primary" onClick={() => setShowDialog(true)}>
        Start Meeting
      </button>

      {showDialog && (
        <div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-meeting-title"
          ref={dialogRef}
          onKeyDown={handleKeyDown}
        >
          <div className="dialog">
            <div className="dialog__icon dialog__icon--info">▶</div>
            <h2 className="dialog__title" id="start-meeting-title">Start Meeting</h2>
            <p className="dialog__body">
              Are you sure you want to start this meeting? This will open voting immediately.
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
                className="btn btn--primary"
                onClick={handleConfirm}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Starting..." : "Confirm Start"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
