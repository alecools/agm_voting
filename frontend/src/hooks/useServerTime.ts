import { useEffect, useRef } from "react";

const SERVER_TIME_TIMEOUT_MS = 5000; // 5 seconds (RR3-29)
/* v8 ignore next -- fallback is unreachable when VITE_API_BASE_URL is defined at build time; defaults to same-origin ("") when env var is absent */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface UseServerTimeResult {
  getServerNow: () => number;
}

export function useServerTime(): UseServerTimeResult {
  const offsetRef = useRef<number>(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SERVER_TIME_TIMEOUT_MS);
    const clientBefore = Date.now();

    fetch(`${API_BASE_URL}/api/server-time`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ utc: string }>;
      })
      .then((data) => {
        const clientAfter = Date.now();
        const serverMs = new Date(data.utc).getTime();
        // Use midpoint for round-trip correction
        const clientMid = (clientBefore + clientAfter) / 2;
        offsetRef.current = serverMs - clientMid;
      })
      .catch(() => {
        // Fallback: use client time (offset stays 0) — covers both timeout (AbortError) and network errors
        offsetRef.current = 0;
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, []);

  return {
    getServerNow: () => Date.now() + offsetRef.current,
  };
}
