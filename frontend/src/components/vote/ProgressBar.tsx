import React from "react";

interface ProgressBarProps {
  answered: number;
  total: number;
}

export function ProgressBar({ answered, total }: ProgressBarProps) {
  const pct = total === 0 ? 0 : Math.round((answered / total) * 100);
  return (
    <div aria-label={`${answered} / ${total} motions answered`}>
      <p>
        {answered} / {total} motions answered
      </p>
      <div
        role="progressbar"
        aria-valuenow={answered}
        aria-valuemin={0}
        aria-valuemax={total}
        style={{
          background: "#e0e0e0",
          borderRadius: "4px",
          height: "8px",
          width: "100%",
        }}
      >
        <div
          style={{
            background: "#1976d2",
            borderRadius: "4px",
            height: "100%",
            width: `${pct}%`,
          }}
        />
      </div>
    </div>
  );
}
