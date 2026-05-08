import { useRef } from "react";
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

  const announced5min = useRef(false);
  const announced1min = useRef(false);

  const hours = Math.floor(secondsRemaining / 3600);
  const minutes = Math.floor((secondsRemaining % 3600) / 60);
  const seconds = secondsRemaining % 60;

  let milestoneMessage = "";
  if (secondsRemaining <= 300 && secondsRemaining > 295 && !announced5min.current) {
    milestoneMessage = "5 minutes remaining";
    announced5min.current = true;
  } else if (secondsRemaining <= 60 && secondsRemaining > 55 && !announced1min.current) {
    milestoneMessage = "1 minute remaining";
    announced1min.current = true;
  }

  if (isExpired) {
    return (
      <div
        role="timer"
        aria-live="assertive"
        className="agm-header__timer agm-header__timer--expired"
      >
        Voting has closed
      </div>
    );
  }

  return (
    <>
      <div
        role="timer"
        aria-live="off"
        className={`agm-header__timer${isWarning ? " agm-header__timer--warning" : ""}`}
      >
        {isWarning && <span aria-hidden="true">! </span>}
        {pad(hours)}:{pad(minutes)}:{pad(seconds)}
      </div>
      <span
        className="sr-only"
        aria-live="assertive"
        aria-atomic="true"
      >
        {milestoneMessage}
      </span>
    </>
  );
}
