import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVotingState } from "../useVotingState";

const MEETING_ID = "agm-branch-test";

beforeEach(() => {
  sessionStorage.clear();
});

// Targeted tests to cover lines 96-105 of useVotingState.ts:
// - handleMultiChoiceChange: if (meetingId) branch (true + false)
// - resetMultiChoiceSelections: if (meetingId) branch (true + false)

describe("useVotingState — lines 96-105 branch coverage", () => {
  it("handleMultiChoiceChange with meetingId writes to sessionStorage (true branch)", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => {
      result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" });
    });
    const stored = sessionStorage.getItem(`meeting_mc_selections_${MEETING_ID}`);
    expect(stored).not.toBeNull();
  });

  it("handleMultiChoiceChange without meetingId skips sessionStorage (false branch)", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: undefined,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => {
      result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" });
    });
    expect(sessionStorage.length).toBe(0);
  });

  it("resetMultiChoiceSelections with meetingId removes sessionStorage (true branch)", () => {
    sessionStorage.setItem(`meeting_mc_selections_${MEETING_ID}`, "{}");
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: MEETING_ID,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => {
      result.current.resetMultiChoiceSelections();
    });
    expect(sessionStorage.getItem(`meeting_mc_selections_${MEETING_ID}`)).toBeNull();
  });

  it("resetMultiChoiceSelections without meetingId does not write sessionStorage (false branch)", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: undefined,
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => {
      result.current.resetMultiChoiceSelections();
    });
    expect(result.current.multiChoiceSelections).toEqual({});
  });
});
