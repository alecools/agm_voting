import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { useServerTime } from "../useServerTime";

const BASE = "http://localhost:8000";

describe("useServerTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a getServerNow function", () => {
    const { result } = renderHook(() => useServerTime());
    expect(typeof result.current.getServerNow).toBe("function");
  });

  it("getServerNow returns a number", async () => {
    const { result } = renderHook(() => useServerTime());
    await waitFor(() => {
      expect(typeof result.current.getServerNow()).toBe("number");
    });
  });

  it("applies server offset after fetch", async () => {
    // Server time is 1 hour ahead of client
    const serverAhead = new Date(Date.now() + 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    server.use(
      http.get(`${BASE}/api/server-time`, () =>
        HttpResponse.json({ utc: serverAhead })
      )
    );

    const { result } = renderHook(() => useServerTime());

    await waitFor(() => {
      // After applying offset, getServerNow() should be ahead of Date.now()
      const diff = result.current.getServerNow() - Date.now();
      expect(diff).toBeGreaterThan(3500 * 1000); // roughly 1 hour ahead
    });
  });

  it("falls back to client time on fetch error", async () => {
    server.use(
      http.get(`${BASE}/api/server-time`, () => HttpResponse.error())
    );

    const before = Date.now();
    const { result } = renderHook(() => useServerTime());

    await waitFor(() => {
      const now = result.current.getServerNow();
      const after = Date.now();
      // Offset should be 0 (fallback), so getServerNow ~= Date.now()
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after + 100);
    });
  });
});
