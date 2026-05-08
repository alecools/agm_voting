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

  // --- US-ACC-04: non-colour cue on warning ---

  it("shows '!' prefix (non-colour cue) when in warning state (under 5 minutes)", () => {
    // 4 minutes from now (within 300s warning window)
    const closesAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const timer = screen.getByRole("timer");
    // The '!' prefix span is aria-hidden but its text content appears in the timer node
    expect(timer).toHaveTextContent(/!/);
  });

  it("does not show '!' prefix when not in warning state", () => {
    // 10 minutes from now — no warning
    const closesAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const timer = screen.getByRole("timer");
    expect(timer).not.toHaveTextContent(/!/);
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

  // --- ACCESSIBILITY-4: aria-live changes ---

  it("running timer has aria-live='off' to prevent per-second announcements", () => {
    const closesAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveAttribute("aria-live", "off");
  });

  it("expired state has aria-live='assertive'", () => {
    const closesAt = new Date(Date.now() - 1000).toISOString();
    const serverTime = makeServerTime(Date.now());
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveAttribute("aria-live", "assertive");
    expect(timer).toHaveTextContent("Voting has closed");
  });

  it("announces '5 minutes remaining' milestone when seconds reach 300", () => {
    const now = Date.now();
    // Set closes at exactly 300 seconds from now
    const closesAt = new Date(now + 300 * 1000).toISOString();
    const serverTime = makeServerTime(now);
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    // At exactly 300s the milestone should fire
    const announcement = document.querySelector(".sr-only");
    expect(announcement).toHaveTextContent("5 minutes remaining");
  });

  it("does not repeat 5-minute announcement on subsequent ticks", () => {
    const now = Date.now();
    let currentNow = now;
    // Set closes at exactly 300 seconds from now
    const closesAt = new Date(now + 300 * 1000).toISOString();
    const serverTime: UseServerTimeResult = { getServerNow: () => currentNow };
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);

    // Advance 1 second (now at 299 seconds)
    currentNow += 1000;
    act(() => { vi.advanceTimersByTime(1000); });

    const announcement = document.querySelector(".sr-only");
    expect(announcement).not.toHaveTextContent("5 minutes remaining");
  });

  it("announces '1 minute remaining' milestone when seconds reach 60", () => {
    const now = Date.now();
    // Set closes at exactly 60 seconds from now
    const closesAt = new Date(now + 60 * 1000).toISOString();
    const serverTime = makeServerTime(now);
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const announcement = document.querySelector(".sr-only");
    expect(announcement).toHaveTextContent("1 minute remaining");
  });

  it("does not announce milestones when well above thresholds", () => {
    const now = Date.now();
    const closesAt = new Date(now + 10 * 60 * 1000).toISOString();
    const serverTime = makeServerTime(now);
    render(<CountdownTimer closesAt={closesAt} serverTime={serverTime} />);
    const announcement = document.querySelector(".sr-only");
    expect(announcement).toHaveTextContent("");
  });
});
