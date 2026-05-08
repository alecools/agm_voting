import { describe, it, expect, beforeEach } from "vitest";
import { loadFromSessionStorage } from "../useVotingState";

beforeEach(() => {
  sessionStorage.clear();
});

describe("loadFromSessionStorage", () => {
  it("returns empty when meetingId is undefined", () => {
    expect(loadFromSessionStorage(undefined)).toEqual({});
  });

  it("returns empty when no sessionStorage entry exists", () => {
    expect(loadFromSessionStorage("test-id")).toEqual({});
  });

  it("returns parsed data from sessionStorage", () => {
    const stored = { mc1: { "opt-a": "for" as const } };
    sessionStorage.setItem("meeting_mc_selections_test-id", JSON.stringify(stored));
    expect(loadFromSessionStorage("test-id")).toEqual(stored);
  });

  it("returns empty on malformed JSON", () => {
    sessionStorage.setItem("meeting_mc_selections_test-id", "not-valid-json");
    expect(loadFromSessionStorage("test-id")).toEqual({});
  });
});
