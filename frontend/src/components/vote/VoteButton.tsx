import React from "react";
import type { VoteChoice } from "../../types";

interface VoteButtonProps {
  choice: VoteChoice;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}

const LABELS: Record<VoteChoice, string> = {
  yes: "Yes",
  no: "No",
  abstained: "Abstain",
};

export function VoteButton({ choice, selected, disabled, onClick }: VoteButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        fontWeight: selected ? "bold" : "normal",
        outline: selected ? "3px solid #1976d2" : undefined,
        opacity: disabled ? 0.5 : 1,
        padding: "8px 20px",
        margin: "0 4px",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {LABELS[choice]}
    </button>
  );
}
