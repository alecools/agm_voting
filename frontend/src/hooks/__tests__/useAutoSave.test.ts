import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { useAutoSave } from "../useAutoSave";

const BASE = "http://localhost:8000";

describe("useAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with idle status", () => {
    const { result } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", null)
    );
    expect(result.current.status).toBe("idle");
  });

  it("transitions to saving then saved after debounce", async () => {
    const { result } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", "yes")
    );

    act(() => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("saved");
    });
  });

  it("shows error status when save fails", async () => {
    server.use(
      http.put(`${BASE}/api/general-meeting/agm-1/draft`, () => HttpResponse.error())
    );

    const { result } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", "no")
    );

    act(() => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
  });

  it("saveNow triggers immediate save", async () => {
    const { result } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", "abstained")
    );

    act(() => {
      result.current.saveNow();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("saved");
    });
  });

  it("saveNow clears pending debounce", async () => {
    const { result } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", "yes")
    );

    // Trigger saveNow before debounce fires
    act(() => {
      result.current.saveNow();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("saved");
    });
  });

  it("debounces rapid choice changes", async () => {
    let choice: "yes" | "no" | null = "yes";
    const { result, rerender } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", choice)
    );

    // Change choice rapidly
    choice = "no";
    rerender();
    choice = "yes";
    rerender();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("saved");
    });
  });
});
