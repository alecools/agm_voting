import React from "react";
import { useCountdown } from "../../hooks/useCountdown";
import type { UseServerTimeResult } from "../../hooks/useServerTime";

interface CountdownTimerProps {
  closesAt: string;
  serverTime: UseServerTimeResult;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function CountdownTimer({ closesAt, serverTime }: CountdownTimerProps) {
  const { secondsRemaining, isExpired, isWarning } = useCountdown(
    closesAt,
    serverTime.getServerNow
  );

  const hours = Math.floor(secondsRemaining / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);
  const seconds = secondsRemaining % 60;

  if (isExpired) {
    return (
      <div
        role="timer"
        aria-live="assertive"
        style={{ color: "#d32f2f", fontWeight: "bold" }}
      >
        Voting has closed
      </div>
    );
  }

  return (
    <div
      role="timer"
      aria-live="polite"
      style={{ color: isWarning ? "#e65100" : undefined, fontWeight: isWarning ? "bold" : undefined }}
    >
      {pad(hours)}:{pad(minutes)}:{pad(seconds)} remaining
      {isWarning && (
        <span style={{ marginLeft: "8px" }}>— closing soon</span>
      )}
    </div>
  );
}
