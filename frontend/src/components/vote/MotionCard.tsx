import React from "react";
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
}

export function MotionCard({
  motion,
  agmId,
  choice,
  onChoiceChange,
  disabled,
  highlight,
}: MotionCardProps) {
  const { status, saveNow } = useAutoSave(agmId, motion.id, choice);

  const handleClick = (c: VoteChoice) => {
    /* c8 ignore next */
    if (disabled) return;
    // Clicking the currently selected choice deselects it
    const next = choice === c ? null : c;
    onChoiceChange(motion.id, next);
  };

  return (
    <div
      data-testid={`motion-card-${motion.id}`}
      style={{
        border: highlight ? "2px solid #ff9800" : "1px solid #ccc",
        borderRadius: "8px",
        padding: "16px",
        marginBottom: "16px",
      }}
    >
      <h3>{motion.title}</h3>
      {motion.description && <p>{motion.description}</p>}
      <div>
        {CHOICES.map((c) => (
          <VoteButton
            key={c}
            choice={c}
            selected={choice === c}
            disabled={disabled}
            onClick={() => handleClick(c)}
          />
        ))}
      </div>
      <SaveIndicator status={status} onSave={saveNow} />
    </div>
  );
}
