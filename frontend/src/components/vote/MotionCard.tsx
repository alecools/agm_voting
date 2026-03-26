import type { VoteChoice } from "../../types";
import type { MotionOut } from "../../api/voter";
import { VoteButton } from "./VoteButton";

const CHOICES: VoteChoice[] = ["yes", "no", "abstained"];

interface MotionCardProps {
  motion: MotionOut;
  position: number;
  choice: VoteChoice | null;
  onChoiceChange: (motionId: string, choice: VoteChoice | null) => void;
  disabled: boolean;
  highlight: boolean;
  readOnly?: boolean;
}

export function MotionCard({
  motion,
  position,
  choice,
  onChoiceChange,
  disabled,
  highlight,
  readOnly = false,
}: MotionCardProps) {
  const handleClick = (c: VoteChoice) => {
    /* c8 ignore next */
    if (disabled || readOnly) return;
    // Clicking the currently selected choice deselects it
    const next = choice === c ? null : c;
    onChoiceChange(motion.id, next);
  };

  const isSpecial = motion.motion_type === "special";
  const isEffectivelyDisabled = disabled || readOnly;

  return (
    <div
      data-testid={`motion-card-${motion.id}`}
      className={`motion-card${highlight ? " motion-card--highlight" : ""}${readOnly ? " motion-card--read-only" : ""}`}
    >
      <div className="motion-card__top-row">
        <p className="motion-card__number">{`Motion ${motion.motion_number?.trim() || position}`}</p>
        <span
          className={`motion-type-badge${isSpecial ? " motion-type-badge--special" : " motion-type-badge--general"}`}
          aria-label={`Motion type: ${isSpecial ? "Special" : "General"}`}
        >
          {isSpecial ? "Special" : "General"}
        </span>
        {readOnly && (
          <span className="motion-card__voted-badge" aria-label="Already voted">
            Already voted
          </span>
        )}
      </div>
      <h3 className="motion-card__title">{motion.title}</h3>
      {motion.description && (
        <p className="motion-card__description">{motion.description}</p>
      )}
      <div className="vote-buttons">
        {CHOICES.map((c) => (
          <VoteButton
            key={c}
            choice={c}
            selected={choice === c}
            disabled={isEffectivelyDisabled}
            ariaDisabled={false}
            onClick={() => handleClick(c)}
          />
        ))}
      </div>
    </div>
  );
}
