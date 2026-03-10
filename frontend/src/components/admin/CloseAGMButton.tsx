import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { closeAGM } from "../../api/admin";
import type { AGMCloseOut } from "../../api/admin";

interface CloseAGMButtonProps {
  agmId: string;
  agmTitle: string;
  onSuccess: () => void;
}

export default function CloseAGMButton({ agmId, agmTitle, onSuccess }: CloseAGMButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation<AGMCloseOut, Error, string>({
    mutationFn: (id) => closeAGM(id),
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
    mutation.mutate(agmId);
  }

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        style={{ background: "#dc3545", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 4, cursor: "pointer" }}
      >
        Close Voting
      </button>

      {showDialog && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
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
              padding: 24,
              borderRadius: 8,
              maxWidth: 400,
              width: "90%",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Close Voting</h3>
            <p>
              Close voting for <strong>{agmTitle}</strong>? This cannot be undone.
            </p>
            {error && <p style={{ color: "#721c24" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setShowDialog(false); setError(null); }}
                disabled={mutation.isPending}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={mutation.isPending}
                style={{ background: "#dc3545", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 4, cursor: "pointer" }}
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
