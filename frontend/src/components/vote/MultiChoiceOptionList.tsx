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
  // RR4-35: whether the option_limit has been reached (for aria-describedby)
  const limitReached = forCount >= optionLimit;

  function handleOptionChoice(optionId: string, choice: "for" | "against" | "abstained") {
    if (disabled || readOnly) return;
    // RR4-35: block adding a new "for" choice when option_limit is already reached
    if (choice === "for" && limitReached && optionChoices[optionId] !== "for") return;
    const next = { ...optionChoices };
    if (next[optionId] === choice) {
      // Clicking the active choice deselects it (removes the entry)
      delete next[optionId];
    } else {
      next[optionId] = choice;
    }
    onChoiceChange(motion.id, next);
  }

  const limitMsgId = `mc-limit-msg-${motion.id}`;

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
      {/* RR3-24: legend associates the group of buttons with the motion question for screen readers */}
      <legend className="motion-card__title" style={{ float: "left", width: "100%", marginBottom: 8 }}>
        {motion.title}
      </legend>
      <p className="multi-choice-counter" data-testid="mc-counter">
        {`Select up to ${optionLimit} option${optionLimit !== 1 ? "s" : ""} — ${forCount} voted For`}
      </p>
      {/* RR4-35: visually hidden message referenced by disabled For buttons when limit is reached */}
      {limitReached && !disabled && !readOnly && (
        <span id={limitMsgId} className="sr-only">
          Maximum selections reached
        </span>
      )}
      {motion.options.map((option) => {
        const currentChoice = optionChoices[option.id];
        const isForSelected = currentChoice === "for";
        const isAgainstSelected = currentChoice === "against";
        const isAbstainSelected = currentChoice === "abstained";
        // RR4-35: For button is disabled when limit reached AND the option is not already selected For
        const isForDisabled = disabled || readOnly || (limitReached && !isForSelected);
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
                aria-describedby={isForDisabled && limitReached && !disabled && !readOnly && !isForSelected ? limitMsgId : undefined}
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
