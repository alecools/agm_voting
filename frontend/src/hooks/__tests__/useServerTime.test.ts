import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { useServerTime } from "../useServerTime";

const BASE = "http://localhost";

describe("useServerTime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    vi.useRealTimers(); // use real timers for this test to avoid timing issues
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
    vi.useRealTimers();
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

  it("falls back to client time when server returns non-OK status", async () => {
    vi.useRealTimers();
    server.use(
      http.get(`${BASE}/api/server-time`, () =>
        HttpResponse.json({ error: "Server Error" }, { status: 500 })
      )
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

  // ── RR3-29: AbortController timeout ──────────────────────────────────────

  it("RR3-29: AbortController is cleaned up on unmount", () => {
    vi.useRealTimers();
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");

    const { unmount } = renderHook(() => useServerTime());
    unmount();

    // abort() must have been called during cleanup
    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });

  it("RR3-29: timeout clears on unmount (no memory leak)", () => {
    vi.useRealTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = renderHook(() => useServerTime());
    unmount();

    // clearTimeout must have been called as part of cleanup
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("RR3-29: timeout callback aborts fetch when server response is slow", async () => {
    // Simulate a slow server — the fetch never resolves within 5s
    server.use(
      http.get(`${BASE}/api/server-time`, async () => {
        // Never respond — the AbortController timeout should fire
        await new Promise(() => {});
        return HttpResponse.json({ utc: new Date().toISOString() });
      })
    );

    const abortSpy = vi.spyOn(AbortController.prototype, "abort");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useServerTime());

    // Advance past the 5-second timeout so the setTimeout callback fires
    await vi.advanceTimersByTimeAsync(5100);

    // The timeout callback should have called abort()
    expect(abortSpy).toHaveBeenCalled();

    vi.useRealTimers();
    abortSpy.mockRestore();
  });
});
