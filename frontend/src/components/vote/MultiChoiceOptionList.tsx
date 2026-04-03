import type { MotionOut, MultiChoiceOptionChoice } from "../../api/voter";

type OptionChoiceMap = Record<string, "for" | "against" | "abstained">;

interface MultiChoiceOptionListProps {
  motion: MotionOut;
  /** option_id → choice ("for" | "against" | "abstained") */
  optionChoices: OptionChoiceMap;
  onChoiceChange: (motionId: string, choices: OptionChoiceMap) => void;
  disabled: boolean;
  readOnly?: boolean;
}

export function MultiChoiceOptionList({
  motion,
  optionChoices,
  onChoiceChange,
  disabled,
  readOnly = false,
}: MultiChoiceOptionListProps) {
  const optionLimit = motion.option_limit ?? motion.options.length;
  const forCount = Object.values(optionChoices).filter((c) => c === "for").length;

  function handleOptionChoice(optionId: string, choice: "for" | "against" | "abstained") {
    if (disabled || readOnly) return;
    const next = { ...optionChoices };
    if (next[optionId] === choice) {
      // Clicking the active choice deselects it (removes the entry)
      delete next[optionId];
    } else {
      next[optionId] = choice;
    }
    onChoiceChange(motion.id, next);
  }

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
      {/* RR3-24: legend associates the group of buttons with the motion question for screen readers */}
      <legend className="motion-card__title" style={{ float: "left", width: "100%", marginBottom: 8 }}>
        {motion.title}
      </legend>
      <p className="multi-choice-counter" data-testid="mc-counter">
        {`Select up to ${optionLimit} option${optionLimit !== 1 ? "s" : ""} — ${forCount} voted For`}
      </p>
      {motion.options.map((option) => {
        const currentChoice = optionChoices[option.id];
        const isForSelected = currentChoice === "for";
        const isAgainstSelected = currentChoice === "against";
        const isAbstainSelected = currentChoice === "abstained";
        const isForDisabled = disabled || readOnly;
        const isEffectivelyDisabled = disabled || readOnly;

        return (
          <div
            key={option.id}
            className="mc-option-row"
            data-testid={`mc-option-row-${option.id}`}
          >
            <span className="mc-option-row__text">{option.text}</span>
            <div className="mc-option-row__buttons" role="group" aria-label={`Vote for ${option.text}`}>
              <button
                type="button"
                className={`vote-btn vote-btn--yes${isForSelected ? " vote-btn--active" : ""}`}
                aria-pressed={isForSelected}
                disabled={isForDisabled}
                onClick={() => handleOptionChoice(option.id, "for")}
                data-testid={`mc-for-${option.id}`}
              >
                <span className="vote-btn__icon" aria-hidden="true">✓</span>
                <span className="vote-btn__label">For</span>
              </button>
              <button
                type="button"
                className={`vote-btn vote-btn--no${isAgainstSelected ? " vote-btn--active" : ""}`}
                aria-pressed={isAgainstSelected}
                disabled={isEffectivelyDisabled}
                onClick={() => handleOptionChoice(option.id, "against")}
                data-testid={`mc-against-${option.id}`}
              >
                <span className="vote-btn__icon" aria-hidden="true">✗</span>
                <span className="vote-btn__label">Against</span>
              </button>
              <button
                type="button"
                className={`vote-btn vote-btn--abstained${isAbstainSelected ? " vote-btn--active" : ""}`}
                aria-pressed={isAbstainSelected}
                disabled={isEffectivelyDisabled}
                onClick={() => handleOptionChoice(option.id, "abstained")}
                data-testid={`mc-abstain-${option.id}`}
              >
                <span className="vote-btn__icon" aria-hidden="true">—</span>
                <span className="vote-btn__label">Abstain</span>
              </button>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Convert OptionChoiceMap to the API submission format.
 */
export function optionChoiceMapToRequest(choices: OptionChoiceMap): MultiChoiceOptionChoice[] {
  return Object.entries(choices).map(([option_id, choice]) => ({ option_id, choice }));
}
