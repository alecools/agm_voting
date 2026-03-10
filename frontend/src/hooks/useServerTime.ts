import { useEffect, useRef } from "react";
import { fetchServerTime } from "../api/voter";

export interface UseServerTimeResult {
  getServerNow: () => number;
}

export function useServerTime(): UseServerTimeResult {
  const offsetRef = useRef<number>(0);

  useEffect(() => {
    const clientBefore = Date.now();
    fetchServerTime()
      .then((data) => {
        const clientAfter = Date.now();
        const serverMs = new Date(data.utc).getTime();
        // Use midpoint for round-trip correction
        const clientMid = (clientBefore + clientAfter) / 2;
        offsetRef.current = serverMs - clientMid;
      })
      .catch(() => {
        // Fallback: use client time (offset stays 0)
        offsetRef.current = 0;
      });
  }, []);

  return {
    getServerNow: () => Date.now() + offsetRef.current,
  };
}
