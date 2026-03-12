import type { VoteChoice } from "../../types";
import type { MotionOut } from "../../api/voter";
import { VoteButton } from "./VoteButton";
import { SaveIndicator } from "./SaveIndicator";
import { useAutoSave } from "../../hooks/useAutoSave";

const CHOICES: VoteChoice[] = ["yes", "no", "abstained"];

interface MotionCardProps {
  motion: MotionOut;
  agmId: string;
  choice: VoteChoice | null;
  onChoiceChange: (motionId: string, choice: VoteChoice | null) => void;
  disabled: boolean;
  highlight: boolean;
  inArrearLocked?: boolean;
  onInArrearClick?: () => void;
}

export function MotionCard({
  motion,
  agmId,
  choice,
  onChoiceChange,
  disabled,
  highlight,
  inArrearLocked = false,
  onInArrearClick,
}: MotionCardProps) {
  const { status, saveNow } = useAutoSave(agmId, motion.id, choice);

  const handleClick = (c: VoteChoice) => {
    /* c8 ignore next */
    if (disabled) return;
    if (inArrearLocked) {
      onInArrearClick?.();
      return;
    }
    // Clicking the currently selected choice deselects it
    const next = choice === c ? null : c;
    onChoiceChange(motion.id, next);
  };

  const isSpecial = motion.motion_type === "special";

  return (
    <div
      data-testid={`motion-card-${motion.id}`}
      className={`motion-card${highlight ? " motion-card--highlight" : ""}`}
    >
      <div className="motion-card__top-row">
        <p className="motion-card__number">Motion {motion.order_index}</p>
        <span
          className={`motion-type-badge${isSpecial ? " motion-type-badge--special" : " motion-type-badge--general"}`}
          aria-label={`Motion type: ${isSpecial ? "Special" : "General"}`}
        >
          {isSpecial ? "Special" : "General"}
        </span>
      </div>
      <h3 className="motion-card__title">{motion.title}</h3>
      {motion.description && (
        <p className="motion-card__description">{motion.description}</p>
      )}
      {inArrearLocked && (
        <p className="motion-card__in-arrear-label" data-testid="in-arrear-label">
          Not eligible (in arrear)
        </p>
      )}
      <div className={`vote-buttons${inArrearLocked ? " vote-buttons--locked" : ""}`}>
        {CHOICES.map((c) => (
          <VoteButton
            key={c}
            choice={c}
            selected={choice === c}
            disabled={disabled}
            ariaDisabled={inArrearLocked}
            onClick={() => handleClick(c)}
          />
        ))}
      </div>
      <div className="motion-card__footer">
        <SaveIndicator status={status} onSave={saveNow} />
      </div>
    </div>
  );
}
