import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVotingState } from "../useVotingState";
import type { MotionOut } from "../../api/voter";

function makeMotion(overrides: Partial<MotionOut> = {}): MotionOut {
  return {
    id: "m1",
    title: "Motion 1",
    description: null,
    display_order: 1,
    motion_number: "1",
    motion_type: "general",
    is_multi_choice: false,
    is_visible: true,
    already_voted: false,
    submitted_choice: null,
    submitted_option_choices: {},
    option_limit: null,
    options: [],
    voting_closed_at: null,
    ...overrides,
  };
}

const MEETING_ID = "agm-123";

beforeEach(() => {
  sessionStorage.clear();
});

// --- Happy path ---

describe("useVotingState — happy path", () => {
  it("starts with empty choices and multiChoiceSelections", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    expect(result.current.choices).toEqual({});
    expect(result.current.multiChoiceSelections).toEqual({});
    expect(result.current.answeredCount).toBe(0);
    expect(result.current.unansweredMotions).toEqual([]);
    expect(result.current.highlightUnanswered).toBe(false);
  });

  it("handleChoiceChange updates choices", () => {
    const motion = makeMotion();
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    act(() => {
      result.current.handleChoiceChange("m1", "yes");
    });
    expect(result.current.choices["m1"]).toBe("yes");
  });

  it("handleChoiceChange to null clears choice", () => {
    const motion = makeMotion();
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    act(() => { result.current.handleChoiceChange("m1", "yes"); });
    act(() => { result.current.handleChoiceChange("m1", null); });
    expect(result.current.choices["m1"]).toBeNull();
  });

  it("handleMultiChoiceChange updates multiChoiceSelections", () => {
    const motion = makeMotion({ is_multi_choice: true });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    act(() => {
      result.current.handleMultiChoiceChange("m1", { "opt-1": "for", "opt-2": "against" });
    });
    expect(result.current.multiChoiceSelections["m1"]).toEqual({ "opt-1": "for", "opt-2": "against" });
  });

  it("handleMultiChoiceChange persists to sessionStorage", () => {
    const motion = makeMotion({ is_multi_choice: true });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    act(() => {
      result.current.handleMultiChoiceChange("m1", { "opt-1": "for" });
    });
    const stored = JSON.parse(sessionStorage.getItem(`meeting_mc_selections_${MEETING_ID}`) ?? "{}");
    expect(stored["m1"]).toEqual({ "opt-1": "for" });
  });

  it("setHighlightUnanswered toggles highlightUnanswered", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => { result.current.setHighlightUnanswered(true); });
    expect(result.current.highlightUnanswered).toBe(true);
  });
});

// --- answeredCount and unansweredMotions ---

describe("useVotingState — answeredCount", () => {
  it("counts answered standard motions", () => {
    const m1 = makeMotion({ id: "m1" });
    const m2 = makeMotion({ id: "m2" });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [m1, m2],
        isMotionReadOnly: () => false,
        unvotedMotions: [m1, m2],
      })
    );
    act(() => { result.current.handleChoiceChange("m1", "yes"); });
    expect(result.current.answeredCount).toBe(1);
    expect(result.current.unansweredMotions).toEqual([m2]);
  });

  it("counts answered multi-choice motions by presence in multiChoiceSelections", () => {
    const mc = makeMotion({ id: "mc1", is_multi_choice: true });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [mc],
        isMotionReadOnly: () => false,
        unvotedMotions: [mc],
      })
    );
    expect(result.current.answeredCount).toBe(0);
    act(() => { result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" }); });
    expect(result.current.answeredCount).toBe(1);
  });

  it("unansweredMotions excludes answered motions", () => {
    const m1 = makeMotion({ id: "m1" });
    const m2 = makeMotion({ id: "m2" });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [m1, m2],
        isMotionReadOnly: () => false,
        unvotedMotions: [m1, m2],
      })
    );
    act(() => { result.current.handleChoiceChange("m1", "no"); });
    act(() => { result.current.handleChoiceChange("m2", "abstained"); });
    expect(result.current.unansweredMotions).toEqual([]);
    expect(result.current.answeredCount).toBe(2);
  });
});

// --- sessionStorage restore on init ---

describe("useVotingState — sessionStorage restore", () => {
  it("restores multiChoiceSelections from sessionStorage on first render", () => {
    const stored = { mc1: { "opt-a": "for" as const } };
    sessionStorage.setItem(`meeting_mc_selections_${MEETING_ID}`, JSON.stringify(stored));
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    expect(result.current.multiChoiceSelections).toEqual(stored);
  });

  it("returns empty object when no sessionStorage entry exists", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    expect(result.current.multiChoiceSelections).toEqual({});
  });

  it("returns empty object when meetingId is undefined", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: undefined,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    expect(result.current.multiChoiceSelections).toEqual({});
  });
});

// --- resetMultiChoiceSelections ---

describe("useVotingState — resetMultiChoiceSelections", () => {
  it("clears multiChoiceSelections", () => {
    const motion = makeMotion({ id: "mc1", is_multi_choice: true });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    act(() => { result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" }); });
    expect(result.current.multiChoiceSelections["mc1"]).toBeDefined();
    act(() => { result.current.resetMultiChoiceSelections(); });
    expect(result.current.multiChoiceSelections).toEqual({});
  });

  it("removes sessionStorage entry on reset", () => {
    const motion = makeMotion({ id: "mc1", is_multi_choice: true });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    act(() => { result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" }); });
    act(() => { result.current.resetMultiChoiceSelections(); });
    expect(sessionStorage.getItem(`meeting_mc_selections_${MEETING_ID}`)).toBeNull();
  });

  it("reset is a no-op for sessionStorage when meetingId is undefined", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: undefined,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => { result.current.resetMultiChoiceSelections(); });
    expect(result.current.multiChoiceSelections).toEqual({});
  });
});

// --- handleMultiChoiceChange skips sessionStorage when meetingId undefined ---

describe("useVotingState — edge cases", () => {
  it("handleMultiChoiceChange does not write sessionStorage when meetingId undefined", () => {
    const spySet = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: undefined,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => { result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" }); });
    expect(spySet).not.toHaveBeenCalled();
    spySet.mockRestore();
  });
});
