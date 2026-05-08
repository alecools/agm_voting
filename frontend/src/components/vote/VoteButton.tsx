import type { VoteChoice } from "../../types";

interface VoteButtonProps {
  choice: VoteChoice;
  selected: boolean;
  disabled: boolean;
  ariaDisabled?: boolean;
  ariaLabel?: string;
  onClick: () => void;
}

const LABELS: Record<VoteChoice, string> = {
  yes: "For",
  no: "Against",
  abstained: "Abstain",
  not_eligible: "Not Eligible",
  selected: "Selected",
};

const ICONS: Record<VoteChoice, string> = {
  yes: "✓",
  no: "✗",
  abstained: "—",
  not_eligible: "—",
  selected: "✓",
};

export function VoteButton({ choice, selected, disabled, ariaDisabled = false, ariaLabel, onClick }: VoteButtonProps) {
  return (
    <button
      type="button"
      className={`vote-btn vote-btn--${choice}${ariaDisabled ? " vote-btn--aria-disabled" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      aria-pressed={selected}
      aria-label={ariaLabel}
    >
      <span className="vote-btn__icon" aria-hidden="true">
        {ICONS[choice]}
      </span>
      <span className="vote-btn__label">{LABELS[choice]}</span>
    </button>
  );
}
