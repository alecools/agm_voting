import { describe, it, expect, beforeEach } from "vitest";
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

// --- Seeding from submitted_choice (revote scenario) ---

describe("useVotingState — seeding from motions (revote)", () => {
  it("seeds choices from already_voted motions that are read-only", () => {
    const motion = makeMotion({
      id: "m1",
      already_voted: true,
      submitted_choice: "yes",
    });
    const isMotionReadOnly = (m: { id: string }) => m.id === "m1";
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly,
        unvotedMotions: [],
      })
    );
    expect(result.current.choices["m1"]).toBe("yes");
  });

  it("does not seed choices for motions that are not read-only", () => {
    const motion = makeMotion({
      id: "m1",
      already_voted: true,
      submitted_choice: "yes",
    });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    expect(result.current.choices["m1"]).toBeUndefined();
  });

  it("does not re-seed choices for motions already in state", () => {
    const motion = makeMotion({
      id: "m1",
      already_voted: true,
      submitted_choice: "yes",
    });
    const isMotionReadOnly = (m: { id: string }) => m.id === "m1";
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly,
        unvotedMotions: [],
      })
    );
    act(() => { result.current.handleChoiceChange("m1", "no"); });
    expect(result.current.choices["m1"]).toBe("no");
  });

  it("seeds multiChoiceSelections for multi-choice read-only motions", () => {
    const motion = makeMotion({
      id: "mc1",
      is_multi_choice: true,
      already_voted: true,
      submitted_choice: "selected",
      submitted_option_choices: { "opt-a": "for", "opt-b": "against" },
    });
    const isMotionReadOnly = (m: { id: string }) => m.id === "mc1";
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly,
        unvotedMotions: [],
      })
    );
    expect(result.current.multiChoiceSelections["mc1"]).toEqual({ "opt-a": "for", "opt-b": "against" });
  });

  it("does not seed multiChoiceSelections for motions not read-only", () => {
    const motion = makeMotion({
      id: "mc1",
      is_multi_choice: true,
      already_voted: true,
      submitted_choice: null,
      submitted_option_choices: { "opt-a": "for" },
    });
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly: () => false,
        unvotedMotions: [motion],
      })
    );
    expect(result.current.multiChoiceSelections["mc1"]).toBeUndefined();
  });

  it("does not seed multiChoiceSelections when submitted_option_choices is empty", () => {
    const motion = makeMotion({
      id: "mc1",
      is_multi_choice: true,
      already_voted: true,
      submitted_choice: "selected",
      submitted_option_choices: {},
    });
    const isMotionReadOnly = (m: { id: string }) => m.id === "mc1";
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [motion],
        isMotionReadOnly,
        unvotedMotions: [],
      })
    );
    expect(result.current.multiChoiceSelections["mc1"]).toBeUndefined();
  });

  it("does not seed when motions is undefined", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: undefined,
        isMotionReadOnly: () => true,
        unvotedMotions: [],
      })
    );
    expect(result.current.choices).toEqual({});
    expect(result.current.multiChoiceSelections).toEqual({});
  });

  it("returns empty object on malformed sessionStorage JSON", () => {
    sessionStorage.setItem(`meeting_mc_selections_${MEETING_ID}`, "not-json");
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
});
