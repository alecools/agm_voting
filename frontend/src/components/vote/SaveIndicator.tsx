import React from "react";
import type { SaveStatus } from "../../hooks/useAutoSave";

interface SaveIndicatorProps {
  status: SaveStatus;
  onSave: () => void;
}

export function SaveIndicator({ status, onSave }: SaveIndicatorProps) {
  if (status === "idle") return null;

  if (status === "saving") {
    return <span aria-live="polite" style={{ color: "#757575", fontSize: "0.85em" }}>Saving...</span>;
  }

  if (status === "saved") {
    return <span aria-live="polite" style={{ color: "#388e3c", fontSize: "0.85em" }}>Saved</span>;
  }

  // error
  return (
    <span aria-live="assertive" style={{ color: "#d32f2f", fontSize: "0.85em" }}>
      Could not save your selection.{" "}
      <button type="button" onClick={onSave}>
        Save
      </button>
    </span>
  );
}
