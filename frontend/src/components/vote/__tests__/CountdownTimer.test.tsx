import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { CountdownTimer } from "../CountdownTimer";
import type { UseServerTimeResult } from "../../../hooks/useServerTime";

function makeServerTime(nowMs: number): UseServerTimeResult {
  return { getServerNow: () => nowMs };
}

describe("CountdownTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows hours, minutes, seconds when time remains", () => {
    // 2 hours from now
    const closesAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    expect(screen.getByRole("timer")).toHaveTextContent(/\d\d:\d\d:\d\d/);
  });

  it("shows expired state when time is 0", () => {
    // already past
    const closesAt = new Date(Date.now() - 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    expect(screen.getByRole("timer")).toHaveTextContent("Voting has closed");
  });

  it("shows warning state at 5 minutes remaining", () => {
    // 4 minutes from now (within 300s warning)
    const closesAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const timer = screen.getByRole("timer");
    expect(timer.className).toMatch(/warning/);
  });

  it("does not show warning at more than 5 minutes remaining", () => {
    // 10 minutes from now
    const closesAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    expect(screen.getByRole("timer")).not.toHaveTextContent(/closing soon/);
  });

  it("counts down over time", () => {
    const now = Date.now();
    const closesAt = new Date(now + 5000).toISOString();
    let currentNow = now;
    const serverTime: UseServerTimeResult = { getServerNow: () => currentNow };
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);

    expect(screen.getByRole("timer")).toHaveTextContent("00:00:05");

    currentNow += 1000;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByRole("timer")).toHaveTextContent("00:00:04");
  });
});
