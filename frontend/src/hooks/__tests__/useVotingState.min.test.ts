import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVotingState } from "../useVotingState";

describe("useVotingState min", () => {
  it("handleMultiChoiceChange writes sessionStorage (line 96-97 true branch)", () => {
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: "t1",
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => {
      result.current.handleMultiChoiceChange("mc1", { "opt-1": "for" });
    });
    expect(sessionStorage.getItem("meeting_mc_selections_t1")).not.toBeNull();
    sessionStorage.clear();
  });

  it("handleMultiChoiceChange skips sessionStorage when no meetingId (line 96 false branch)", () => {
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

  it("resetMultiChoiceSelections removes sessionStorage (line 103-105 true branch)", () => {
    sessionStorage.setItem("meeting_mc_selections_t2", "{}");
    const { result } = renderHook(() =>
      useVotingState({
        meetingId: "t2",
        motions: [],
        isMotionReadOnly: () => false,
        unvotedMotions: [],
      })
    );
    act(() => {
      result.current.resetMultiChoiceSelections();
    });
    expect(sessionStorage.getItem("meeting_mc_selections_t2")).toBeNull();
  });

  it("resetMultiChoiceSelections no-op when no meetingId (line 105 false branch)", () => {
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
