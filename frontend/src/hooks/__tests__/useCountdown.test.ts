import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown } from "../useCountdown";

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns seconds remaining", () => {
    const now = Date.now();
    const closesAt = new Date(now + 100000).toISOString();
    const { result } = renderHook(() =>
      useCountdown(closesAt, () => now)
    );
    expect(result.current.secondsRemaining).toBe(100);
  });

  it("isExpired is false when time remains", () => {
    const now = Date.now();
    const closesAt = new Date(now + 10000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.isExpired).toBe(false);
  });

  it("isExpired is true when past closing time", () => {
    const now = Date.now();
    const closesAt = new Date(now - 1000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.isExpired).toBe(true);
  });

  it("secondsRemaining is 0 when past closing time", () => {
    const now = Date.now();
    const closesAt = new Date(now - 5000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.secondsRemaining).toBe(0);
  });

  it("isWarning is true at 300 seconds remaining", () => {
    const now = Date.now();
    const closesAt = new Date(now + 300 * 1000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.isWarning).toBe(true);
  });

  it("isWarning is true below 300 seconds", () => {
    const now = Date.now();
    const closesAt = new Date(now + 120 * 1000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.isWarning).toBe(true);
  });

  it("isWarning is false above 300 seconds", () => {
    const now = Date.now();
    const closesAt = new Date(now + 600 * 1000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.isWarning).toBe(false);
  });

  it("isWarning is false when expired", () => {
    const now = Date.now();
    const closesAt = new Date(now - 1000).toISOString();
    const { result } = renderHook(() => useCountdown(closesAt, () => now));
    expect(result.current.isWarning).toBe(false);
  });

  it("counts down each second via interval", () => {
    let now = Date.now();
    const closesAt = new Date(now + 5000).toISOString();
    const { result } = renderHook(() =>
      useCountdown(closesAt, () => now)
    );
    expect(result.current.secondsRemaining).toBe(5);

    now += 1000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.secondsRemaining).toBe(4);
  });

  it("cleans up interval on unmount", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const now = Date.now();
    const closesAt = new Date(now + 10000).toISOString();
    const { unmount } = renderHook(() => useCountdown(closesAt, () => now));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
