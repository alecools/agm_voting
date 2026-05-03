import type { VoteChoice } from "../../types";
import type { MotionOut } from "../../api/voter";
import { VoteButton } from "./VoteButton";
import { MultiChoiceOptionList } from "./MultiChoiceOptionList";

const CHOICES: VoteChoice[] = ["yes", "no", "abstained"];

const MOTION_TYPE_LABELS: Record<string, string> = {
  general: "General",
  special: "Special",
};

type OptionChoiceMap = Record<string, "for" | "against" | "abstained">;

interface MotionCardProps {
  motion: MotionOut;
  position: number;
  choice: VoteChoice | null;
  onChoiceChange: (motionId: string, choice: VoteChoice | null) => void;
  disabled: boolean;
  highlight: boolean;
  readOnly?: boolean;
  votingClosed?: boolean;
  // Multi-choice state (only used for multi_choice motion type)
  multiChoiceOptionChoices?: OptionChoiceMap;
  onMultiChoiceChange?: (motionId: string, choices: OptionChoiceMap) => void;
}

export function MotionCard({
  motion,
  position,
  choice,
  onChoiceChange,
  disabled,
  highlight,
  readOnly = false,
  votingClosed = false,
  multiChoiceOptionChoices = {},
  onMultiChoiceChange,
}: MotionCardProps) {
  const handleClick = (c: VoteChoice) => {
    /* c8 ignore next */
    if (disabled || readOnly) return;
    // Clicking the currently selected choice deselects it
    const next = choice === c ? null : c;
    onChoiceChange(motion.id, next);
  };

  const isMultiChoice = motion.is_multi_choice;
  const isSpecial = motion.motion_type === "special";
  const isEffectivelyDisabled = disabled || readOnly;

  // Fix 6: badge class and label always derived from motion_type, never from isMultiChoice
  const badgeClass = isSpecial ? "motion-type-badge--special" : "motion-type-badge--general";
  const typeLabel = MOTION_TYPE_LABELS[motion.motion_type] ?? motion.motion_type;

  return (
    <div
      data-testid={`motion-card-${motion.id}`}
      className={`motion-card${highlight ? " motion-card--highlight" : ""}${readOnly ? " motion-card--read-only" : ""}${votingClosed ? " motion-card--closed" : ""}`}
    >
      <div className="motion-card__top-row">
        <p className="motion-card__number">{`Motion ${motion.motion_number?.trim() || position}`}</p>
        <span
          className={`motion-type-badge ${badgeClass}`}
          aria-label={`Motion type: ${typeLabel}`}
        >
          {typeLabel}
        </span>
        {/* Fix 6: render Multi-Choice as a second supplementary badge */}
        {isMultiChoice && (
          <span className="motion-type-badge motion-type-badge--multi_choice" aria-label="Multi-choice motion">
            Multi-Choice
          </span>
        )}
        {highlight && (
          <span className="motion-card__unanswered-badge" aria-label="Unanswered">
            ! Unanswered
          </span>
        )}
        {readOnly && (
          <span className="motion-card__voted-badge" aria-label="Already voted">
            ✓ Already voted
          </span>
        )}
      </div>
      <h3 className="motion-card__title">{motion.title}</h3>
      {motion.description && (
        <p className="motion-card__description">{motion.description}</p>
      )}
      {/* Fix 10: styled "Motion Closed" badge inside the card */}
      {votingClosed && (
        <span
          className="motion-type-badge motion-type-badge--closed"
          role="status"
          aria-label="Motion voting is closed"
          data-testid={`motion-closed-label-${motion.id}`}
        >
          Motion Closed
        </span>
      )}
      {isMultiChoice ? (
        <MultiChoiceOptionList
          motion={motion}
          optionChoices={multiChoiceOptionChoices}
          onChoiceChange={onMultiChoiceChange ?? (() => {})}
          disabled={isEffectivelyDisabled}
          readOnly={readOnly}
        />
      ) : (
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
      )}
    </div>
  );
}
