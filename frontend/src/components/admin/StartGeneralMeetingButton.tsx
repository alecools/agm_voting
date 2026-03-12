import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { startGeneralMeeting } from "../../api/admin";
import type { GeneralMeetingStartOut } from "../../api/admin";

interface StartGeneralMeetingButtonProps {
  meetingId: string;
  onSuccess: () => void;
}

export default function StartGeneralMeetingButton({ meetingId, onSuccess }: StartGeneralMeetingButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function handleConfirm() {
    mutation.mutate(meetingId);
  }

  return (
    <>
      <button className="btn btn--primary" onClick={() => setShowDialog(true)}>
        Start Meeting
      </button>

      {showDialog && (
        <div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="start-meeting-title">
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
