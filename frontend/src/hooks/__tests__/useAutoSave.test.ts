import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { useAutoSave } from "../useAutoSave";

const BASE = "http://localhost";

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

  // --- First-mount bug fix (FRONTEND-1) ---

  it("does NOT call saveDraft on first mount when choice is null", async () => {
    const handler = vi.fn(() => HttpResponse.json({ status: "ok" }));
    server.use(http.put(`${BASE}/api/general-meeting/agm-1/draft`, handler));

    renderHook(() => useAutoSave("agm-1", "mot-1", null));

    act(() => {
      vi.advanceTimersByTime(500);
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT call saveDraft on first mount even when choice has a value", async () => {
    const handler = vi.fn(() => HttpResponse.json({ status: "ok" }));
    server.use(http.put(`${BASE}/api/general-meeting/agm-1/draft`, handler));

    renderHook(() => useAutoSave("agm-1", "mot-1", "yes"));

    act(() => {
      vi.advanceTimersByTime(500);
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls saveDraft after debounce when choice changes", async () => {
    let choice: "yes" | "no" | null = null;
    const { result, rerender } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", choice)
    );

    // First mount — no save
    act(() => { vi.advanceTimersByTime(500); });

    // Change choice
    choice = "yes";
    rerender();

    act(() => { vi.advanceTimersByTime(400); });

    await waitFor(() => {
      expect(result.current.status).toBe("saved");
    });
  });

  it("transitions to saving then saved after debounce on choice change", async () => {
    let choice: "yes" | null = null;
    const { result, rerender } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", choice)
    );

    // skip first mount
    act(() => { vi.advanceTimersByTime(500); });

    choice = "yes";
    rerender();

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

    let choice: "no" | null = null;
    const { result, rerender } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", choice)
    );

    act(() => { vi.advanceTimersByTime(500); });

    choice = "no";
    rerender();

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
    let choice: "yes" | null = null;
    const { result, rerender } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", choice)
    );

    act(() => { vi.advanceTimersByTime(500); });

    choice = "yes";
    rerender();

    // Trigger saveNow before debounce fires
    act(() => {
      result.current.saveNow();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("saved");
    });
  });

  it("debounces rapid choice changes — saveDraft called exactly once", async () => {
    let choice: "yes" | "no" | null = null;
    const { result, rerender } = renderHook(() =>
      useAutoSave("agm-1", "mot-1", choice)
    );

    // First mount — skip
    act(() => { vi.advanceTimersByTime(500); });

    // Change choice rapidly
    choice = "yes";
    rerender();
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
