import { useState, useEffect } from "react";

export interface UseCountdownResult {
  secondsRemaining: number;
  isExpired: boolean;
  isWarning: boolean;
}

export function useCountdown(
  closesAt: string,
  getServerNow: () => number
): UseCountdownResult {
  const closesAtMs = new Date(closesAt).getTime();

  const computeSeconds = () => {
    const remaining = Math.floor((closesAtMs - getServerNow()) / 1000);
    return remaining < 0 ? 0 : remaining;
  };

  const [secondsRemaining, setSecondsRemaining] = useState<number>(computeSeconds);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsRemaining(computeSeconds());
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closesAt]);

  return {
    secondsRemaining,
    isExpired: secondsRemaining <= 0,
    isWarning: secondsRemaining > 0 && secondsRemaining <= 300,
  };
}
