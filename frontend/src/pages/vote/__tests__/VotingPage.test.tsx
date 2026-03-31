import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { VotingPage } from "../VotingPage";
import { AGM_ID, BUILDING_ID, MOTION_ID_1, MOTION_ID_2, MOTION_ID_MC, mcMotionFixtureVoter } from "../../../../tests/msw/handlers";
import * as voterApi from "../../../api/voter";

const BASE = "http://localhost:8000";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(meetingId = AGM_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/vote/${meetingId}/voting`]}>
        <Routes>
          <Route path="/vote/:meetingId/voting" element={<VotingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("VotingPage", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Session restore is attempted on every VotingPage mount via the HttpOnly cookie.
    // Default to 401 so tests that seed sessionStorage with specific lot data don't have
    // it silently overwritten by the restore response. Individual tests that need a
    // successful restore can override this handler.
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({ detail: "Session expired or invalid" }, { status: 401 })
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all motions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Motion 2" })).toBeInTheDocument();
    });
  });

  it("uses display_order (not array index) as motion position label when first visible motion has display_order 2", async () => {
    // Simulates a hidden motion 1 excluded from the list: the first element has display_order 2.
    // Without the fix, position={index + 1} would render "Motion 1" as the position label;
    // with the fix it correctly renders "Motion 2".
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          {
            id: MOTION_ID_2,
            title: "Approve the levy",
            description: null,
            display_order: 2,
            motion_number: null,
            motion_type: "general",
            is_visible: true,
            already_voted: false,
            submitted_choice: null,
          },
        ])
      )
    );
    renderPage();
    await waitFor(() => {
      // The position label (rendered in a <p> by MotionCard) must be "Motion 2" (from
      // display_order), not "Motion 1" (from array index 0 + 1).
      expect(screen.getByText("Motion 2")).toBeInTheDocument();
      expect(screen.queryByText("Motion 1")).not.toBeInTheDocument();
    });
  });

  it("uses display_order for both motions when first visible motion has display_order 2 and second has display_order 3", async () => {
    // Simulates a meeting where motion 1 is hidden (excluded from the visible list).
    // The visible motions have display_order 2 and 3.
    // Bug: position={index + 1} would render "Motion 1" / "Motion 2".
    // Fix: position={motion.display_order} renders "Motion 2" / "Motion 3".
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          {
            id: MOTION_ID_1,
            title: "Second Motion",
            description: null,
            display_order: 2,
            motion_number: null,
            motion_type: "general",
            is_visible: true,
            already_voted: false,
            submitted_choice: null,
          },
          {
            id: MOTION_ID_2,
            title: "Third Motion",
            description: null,
            display_order: 3,
            motion_number: null,
            motion_type: "special",
            is_visible: true,
            already_voted: false,
            submitted_choice: null,
          },
        ])
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion 2")).toBeInTheDocument();
      expect(screen.getByText("Motion 3")).toBeInTheDocument();
    });
    // Array-index labels must NOT appear
    expect(screen.queryByText("Motion 1")).not.toBeInTheDocument();
  });

  it("renders 'Motion {motion_number}' heading when motion has a non-null motion_number", async () => {
    // When motion_number is set (e.g. "SR-1"), the label should read "Motion SR-1",
    // not "Motion 1" (display_order fallback).
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          {
            id: MOTION_ID_1,
            title: "Special Resolution Budget",
            description: null,
            display_order: 1,
            motion_number: "SR-1",
            motion_type: "general",
            is_visible: true,
            already_voted: false,
            submitted_choice: null,
          },
        ])
      )
    );
    renderPage();
    await waitFor(() => {
      // "Motion SR-1" should appear (MotionCard prepends "Motion " to motion_number)
      expect(screen.getByText("Motion SR-1")).toBeInTheDocument();
    });
    // The numeric position label must NOT appear as the heading
    expect(screen.queryByText("Motion 1")).not.toBeInTheDocument();
  });

  it("renders AGM title and building name", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
      expect(screen.getByText("Sunset Towers")).toBeInTheDocument();
    });
  });

  it("does not restore draft choices from server on load (no mid-session persistence)", async () => {
    // Drafts endpoint is called but choices are NOT pre-populated — choices live in React state only.
    // Even if the server returns a saved draft, the page starts with no choices selected.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/drafts`, () =>
        HttpResponse.json({
          drafts: [{ motion_id: MOTION_ID_1, choice: "yes" }],
        })
      )
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("button", { name: "For" }));
    // Despite the server returning a draft, no button is pre-selected
    const yesButtons = screen.getAllByRole("button", { name: "For" });
    expect(yesButtons[0]).toHaveAttribute("aria-pressed", "false");
    expect(yesButtons[1]).toHaveAttribute("aria-pressed", "false");
  });

  it("progress bar updates on selection", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByLabelText("0 / 2 motions answered"));

    const yesButtons = await waitFor(() => screen.getAllByRole("button", { name: "For" }));
    await user.click(yesButtons[0]);

    await waitFor(() => {
      expect(screen.getByLabelText("1 / 2 motions answered")).toBeInTheDocument();
    });
  });

  it("deselects choice when same button clicked again", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    const yesButtons = await waitFor(() => screen.getAllByRole("button", { name: "For" }));
    await user.click(yesButtons[0]);
    await waitFor(() => screen.getByLabelText("1 / 2 motions answered"));

    await user.click(yesButtons[0]);
    await waitFor(() => {
      expect(screen.getByLabelText("0 / 2 motions answered")).toBeInTheDocument();
    });
  });

  it("shows simple confirm dialog when all motions answered", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getAllByRole("button", { name: "For" }));

    const yesButtons = screen.getAllByRole("button", { name: "For" });
    await user.click(yesButtons[0]);
    await user.click(yesButtons[1]);

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Are you sure? Votes cannot be changed after submission.")).toBeInTheDocument();
    });
  });

  it("shows unanswered review dialog when not all answered", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Unanswered motions")).toBeInTheDocument();
    });
  });

  it("highlights unanswered motions on submit click", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      const cards = screen.getAllByTestId(/motion-card/);
      cards.forEach((card) => {
        expect(card).toHaveClass("motion-card--highlight");
      });
    });
  });

  it("cancels dialog and stays on page", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("navigates to confirmation on successful submit", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("navigates to confirmation on 409 (already submitted)", async () => {
    server.use(
      http.post(`${BASE}/api/general-meeting/${AGM_ID}/submit`, () =>
        HttpResponse.json({ detail: "already submitted" }, { status: 409 })
      )
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("shows ClosedBanner on 403 during submit", async () => {
    server.use(
      http.post(`${BASE}/api/general-meeting/${AGM_ID}/submit`, () =>
        HttpResponse.json({ detail: "closed" }, { status: 403 })
      )
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => {
      expect(screen.getByText("Voting has closed for this meeting.")).toBeInTheDocument();
    });
  });

  it("shows ClosedBanner and disables inputs when poll detects closed AGM", async () => {
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () =>
        HttpResponse.json([
          {
            id: AGM_ID,
            title: "2024 AGM",
            status: "closed",
            meeting_at: "2024-06-01T10:00:00Z",
            voting_closes_at: "2024-06-01T12:00:00Z",
          },
        ])
      )
    );
    renderPage();

    // Wait for buildings to load (needed before polling starts)
    await waitFor(() => screen.getByText("2024 AGM"));

    // Advance past the 10-second poll interval
    act(() => {
      vi.advanceTimersByTime(11000);
    });

    await waitFor(() => {
      expect(screen.getByText("Voting has closed for this meeting.")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("shows 5-minute warning banner", async () => {
    // Set voting_closes_at to 4 minutes from now
    const closesAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    server.use(
      http.get(`${BASE}/api/server-time`, () =>
        HttpResponse.json({ utc: new Date().toISOString() })
      ),
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () =>
        HttpResponse.json([
          {
            id: AGM_ID,
            title: "2024 AGM",
            status: "open",
            meeting_at: "2024-06-01T10:00:00Z",
            voting_closes_at: closesAt,
          },
        ])
      )
    );
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText("Voting closes in 5 minutes — please submit your ballot")
      ).toBeInTheDocument();
    });
  });

  it("shows countdown timer", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("timer")).toBeInTheDocument();
    });
  });

  it("does not auto-save to server when a choice is selected", async () => {
    // Draft auto-save is removed — choosing a vote should not trigger any PUT /draft call.
    const saveDraftSpy = vi.spyOn(voterApi, "saveDraft");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    const yesButtons = await waitFor(() => screen.getAllByRole("button", { name: "For" }));
    await user.click(yesButtons[0]);
    act(() => { vi.advanceTimersByTime(1000); });
    // No draft save should have been called
    expect(saveDraftSpy).not.toHaveBeenCalled();
    // No "Saved" indicator anywhere on the page
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
    saveDraftSpy.mockRestore();
  });

  it("poll finds open AGM (no status change - stays open)", async () => {
    // AGM remains open in poll — the `if (found) return` branch
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () =>
        HttpResponse.json([
          {
            id: AGM_ID,
            title: "2024 AGM",
            status: "open",
            meeting_at: "2024-06-01T10:00:00Z",
            voting_closes_at: "2024-06-01T12:00:00Z",
          },
        ])
      )
    );
    renderPage();
    await waitFor(() => screen.getByText("2024 AGM"));

    act(() => { vi.advanceTimersByTime(11000); });

    // Should NOT show closed banner since still open
    await waitFor(() => {
      expect(screen.queryByText("Voting has closed for this meeting.")).not.toBeInTheDocument();
    });
  });

  it("poll handles fetch error gracefully (continues)", async () => {
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () => HttpResponse.error())
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));

    act(() => { vi.advanceTimersByTime(11000); });

    // Error in poll catch — should still be on voting page
    expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
  });

  it("handles fetch error during initial building lookup", async () => {
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () => HttpResponse.error())
    );
    renderPage();
    // Motions still load (separate query), building info just won't appear
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // Building name and AGM title won't appear (header not shown)
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
  });

  // --- Back navigation ---

  it("renders back button", async () => {
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
  });

  it("back button navigates to auth page", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/auth`);
  });

  // --- Lot selection panel ---

  it("single-lot non-proxy: lot panel not shown, motions immediately visible", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Your Lots" })).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("single-lot proxy: lot info shown with 'via Proxy' badge and motions immediately visible", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "99", financial_position: "normal", already_submitted: false, is_proxy: true }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your Lots" })).toBeInTheDocument();
    });
    expect(screen.getAllByText("via Proxy")[0]).toBeInTheDocument();
    // Old badge text must be gone
    expect(screen.queryByText("Lot 99 via Proxy")).not.toBeInTheDocument();
    // No "Start Voting" button — motions are immediately visible
    expect(screen.queryByRole("button", { name: "Start Voting" })).not.toBeInTheDocument();
    // Motions immediately visible (no gate)
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("single-lot proxy: motions are visible alongside lot info without any Start Voting click", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "99", financial_position: "normal", already_submitted: false, is_proxy: true }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    // Lot info strip is visible at the same time
    expect(screen.getByRole("heading", { name: "Your Lots" })).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("single-lot proxy already submitted: shows Already submitted badge and View Submission button", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "99", financial_position: "normal", already_submitted: true, is_proxy: true, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText("Already submitted")[0]).toBeInTheDocument();
    });
    // Both the inline lot panel and the submit-section show "View Submission" when all motions
    // are already voted on (isLotSubmitted=true → readOnly → unvotedMotions=[]).
    const viewSubmissionBtns = screen.getAllByRole("button", { name: "View Submission" });
    expect(viewSubmissionBtns.length).toBeGreaterThanOrEqual(1);
    await user.click(viewSubmissionBtns[0]);
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: sidebar shown with checkboxes and subtitle count, motions visible alongside", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your Lots" })).toBeInTheDocument();
    });
    expect(screen.getAllByText("You are voting for 2 lots.")[0]).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    // Motions are immediately visible — no Start Voting gate
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- US-ACC-01: lot checkboxes inside <label> elements ---

  it("US-ACC-01: lot checkbox is inside a <label> element with associated lot number text", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "5", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "6", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Each checkbox should be labelled by its associated lot number text via <label>
    const lot5Checkbox = screen.getAllByLabelText("Lot 5")[0];
    expect(lot5Checkbox).toBeInTheDocument();
    expect(lot5Checkbox.tagName).toBe("INPUT");
    expect(lot5Checkbox).toHaveAttribute("type", "checkbox");
    // The checkbox should be inside a <label> element
    expect(lot5Checkbox.closest("label")).not.toBeNull();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("US-ACC-01: clicking lot number text (via label) toggles the checkbox", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "7", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "8", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Clicking the label text "Lot 7" should toggle the checkbox
    const lot7Checkbox = screen.getAllByLabelText("Lot 7")[0];
    expect(lot7Checkbox).toBeChecked();
    // Click the label (the label text triggers checkbox toggle)
    const label = lot7Checkbox.closest("label") as HTMLLabelElement;
    await user.click(label);
    expect(lot7Checkbox).not.toBeChecked();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: unchecking a lot updates subtitle count", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    expect(screen.getAllByText("You are voting for 1 lot.")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: Submit ballot with no lots selected shows validation alert", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    // Submit ballot button (no Start Voting gate) — clicking with no lots selected triggers alert
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Please select at least one lot");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: Submit ballot writes selected IDs to sessionStorage", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    // Motions are immediately visible — uncheck lot 2 then submit
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    // Click Submit ballot — it writes selected IDs to sessionStorage before opening dialog
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    const stored = JSON.parse(sessionStorage.getItem(`meeting_lots_${AGM_ID}`) ?? "[]") as string[];
    expect(stored).toEqual(["lo1"]);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  // --- C-7: sessionStorage race condition fix ---

  it("C-7: submitBallot called with lot_owner_ids from selected lots at confirm time, not re-read from sessionStorage", async () => {
    // The fix: lot IDs are passed directly as mutation parameters at confirm time,
    // so the mutationFn never needs to read sessionStorage.
    const submitSpy = vi.spyOn(voterApi, "submitBallot").mockResolvedValue({
      submitted: true,
      lots: [],
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));

    // Deselect lot 2 — only lo1 should be submitted
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]); // uncheck lo2

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));

    // Clear sessionStorage BEFORE confirming — simulates a race where sessionStorage
    // is wiped between handleSubmitClick and the async mutationFn executing.
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalled();
    });

    // Must use the lot IDs captured at confirm time (lo1 only), not re-read from
    // (now-empty) sessionStorage which would produce [].
    const callArg = submitSpy.mock.calls[0][1];
    expect(callArg.lot_owner_ids).toEqual(["lo1"]);

    submitSpy.mockRestore();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("C-7: single-lot submitBallot receives the lot_owner_id from allLots state, not sessionStorage", async () => {
    // Single-lot path: lotsToSubmit = allLots.map(l => l.lot_owner_id) at confirm time.
    const submitSpy = vi.spyOn(voterApi, "submitBallot").mockResolvedValue({
      submitted: true,
      lots: [],
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "single-lo", lot_number: "5", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));

    // Clear meeting_lots sessionStorage key entirely before submit
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalled();
    });

    // The lot ID must come from allLots state (seeded from meeting_lots_info), not from
    // meeting_lots sessionStorage which was cleared above.
    const callArg = submitSpy.mock.calls[0][1];
    expect(callArg.lot_owner_ids).toEqual(["single-lo"]);

    submitSpy.mockRestore();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: proxy badge shows 'via Proxy' (not lot number) in sidebar", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    expect(screen.getAllByText("via Proxy")[0]).toBeInTheDocument();
    // Must NOT contain "Lot 2 via Proxy" — badge text is just "via Proxy"
    expect(screen.queryByText("Lot 2 via Proxy")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: in-arrear badge shown in lot panel", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    expect(screen.getAllByText("In Arrear")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: already-submitted lot has disabled checkbox and submitted badge", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[1]).toBeDisabled();
    expect(screen.getAllByText("Already submitted")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("all-submitted lots (multi-lot): shows View Submission button", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Voting" })).not.toBeInTheDocument();
    expect(screen.getAllByText("All lots have been submitted.")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("all-submitted lots (multi-lot): View Submission button navigates to confirmation", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "View Submission" }));
    await user.click(screen.getByRole("button", { name: "View Submission" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("lot panel not shown when sessionStorage is empty", async () => {
    // No meeting_lots_info set — lotsConfirmed initialises to true
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Your Lots" })).not.toBeInTheDocument();
  });

  it("lot panel not shown on invalid JSON in meeting_lots_info", async () => {
    sessionStorage.setItem(`meeting_lots_info_${AGM_ID}`, "not-valid-json{{{");
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Your Lots" })).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: re-checking a lot clears the no-selection error", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    const checkboxes = screen.getAllByRole("checkbox");
    // Uncheck all and trigger error via Submit ballot
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Re-check one — alert should clear
    await user.click(checkboxes[0]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- in-arrear lot tests ---

  it("in-arrear single lot: shows all-in-arrear banner but general motions remain fully interactive", async () => {
    // In-arrear restriction is per-lot at the backend; the frontend does not disable
    // General Motion buttons. The arrear banner is informational only.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_number: null, motion_type: "general" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_number: null, motion_type: "special" },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo-1", lot_number: "5A", financial_position: "in_arrear", already_submitted: false, is_proxy: false }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    // Banner shown (all selected lots are in arrear)
    await waitFor(() => {
      expect(screen.getByTestId("arrear-banner")).toBeInTheDocument();
    });
    // Vote buttons on the general motion are NOT disabled — in-arrear restriction is backend-only
    const forButtons = screen.getAllByRole("button", { name: "For" });
    expect(forButtons[0]).not.toHaveAttribute("aria-disabled");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("in-arrear single lot: general motions voteable, progress bar counts actual choices only", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "General Motion", description: null, display_order: 1, motion_number: null, motion_type: "general" },
          { id: MOTION_ID_2, title: "Special Motion", description: null, display_order: 2, motion_number: null, motion_type: "special" },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo-1", lot_number: "5A", financial_position: "in_arrear", already_submitted: false, is_proxy: false }])
    );
    renderPage();
    // Neither motion is auto-answered — progress starts at 0/2
    await waitFor(() => {
      expect(screen.getByLabelText("0 / 2 motions answered")).toBeInTheDocument();
    });
    // Voter CAN vote on the general motion
    const forButtons = screen.getAllByRole("button", { name: "For" });
    await user.click(forButtons[0]);
    await waitFor(() => {
      expect(screen.getByLabelText("1 / 2 motions answered")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Submit directly from state (no draft flush) ---

  it("confirm calls submitBallot directly without calling saveDraft", async () => {
    const saveDraftSpy = vi.spyOn(voterApi, "saveDraft");
    const submitSpy = vi.spyOn(voterApi, "submitBallot").mockResolvedValue({
      submitted: true,
      lots: [],
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getAllByRole("button", { name: "For" }));

    const yesButtons = screen.getAllByRole("button", { name: "For" });
    await user.click(yesButtons[0]);

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalled();
    });
    // saveDraft must never be called — no flush step
    expect(saveDraftSpy).not.toHaveBeenCalled();

    saveDraftSpy.mockRestore();
    submitSpy.mockRestore();
  });

  // --- Regression: inline votes are passed in submit request ---

  it("regression: submit request includes inline votes with actual choices (not abstained)", async () => {
    const submitSpy = vi.spyOn(voterApi, "submitBallot").mockResolvedValue({
      submitted: true,
      lots: [],
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getAllByRole("button", { name: "For" }));

    // Select Yes on motion 1, No on motion 2
    const yesButtons = screen.getAllByRole("button", { name: "For" });
    const noButtons = screen.getAllByRole("button", { name: "Against" });
    await user.click(yesButtons[0]); // motion 1 → yes
    await user.click(noButtons[1]);  // motion 2 → no

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalled();
    });

    const callArg = submitSpy.mock.calls[0][1];
    const votesMap = Object.fromEntries(callArg.votes.map((v) => [v.motion_id, v.choice]));
    expect(votesMap[MOTION_ID_1]).toBe("yes");
    expect(votesMap[MOTION_ID_2]).toBe("no");

    submitSpy.mockRestore();
  });

  it("regression: submit request with no choices sends empty votes array (results in abstained)", async () => {
    const submitSpy = vi.spyOn(voterApi, "submitBallot").mockResolvedValue({
      submitted: true,
      lots: [],
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));

    // Submit without selecting any choice
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalled();
    });

    const callArg = submitSpy.mock.calls[0][1];
    // No choices selected → empty votes array
    expect(callArg.votes).toHaveLength(0);

    submitSpy.mockRestore();
  });

  // --- In-arrear warning banner ---

  it("arrear banner not shown when no lots are in arrear", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    expect(screen.queryByTestId("arrear-banner")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("arrear banner not shown for single-lot non-arrear voter", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    expect(screen.queryByTestId("arrear-banner")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("arrear banner shown with mixed message when some selected lots are in arrear", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByTestId("arrear-banner"));
    const banner = screen.getByTestId("arrear-banner");
    expect(banner).toHaveTextContent("Some of your selected lots are in arrear");
    expect(banner).toHaveTextContent("recorded as not eligible");
    expect(banner).toHaveTextContent("Votes for all other lots will be recorded normally");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("arrear banner shown with all-in-arrear message when all selected lots are in arrear", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByTestId("arrear-banner"));
    const banner = screen.getByTestId("arrear-banner");
    expect(banner).toHaveTextContent("All your selected lots are in arrear");
    expect(banner).toHaveTextContent("You may only vote on Special Motions");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("arrear banner updates when a lot is unchecked to remove all in-arrear from selection", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByTestId("arrear-banner"));
    // Uncheck the in-arrear lot — banner should disappear
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]); // uncheck lo1 (in_arrear)
    await waitFor(() => {
      expect(screen.queryByTestId("arrear-banner")).not.toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("arrear banner changes from mixed to all-in-arrear when normal lot unchecked", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "in_arrear", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByTestId("arrear-banner"));
    expect(screen.getByTestId("arrear-banner")).toHaveTextContent("Some of your selected lots are in arrear");
    // Uncheck the normal lot — now all remaining selected lots are in arrear
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]); // uncheck lo2 (normal)
    await waitFor(() => {
      expect(screen.getByTestId("arrear-banner")).toHaveTextContent("All your selected lots are in arrear");
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Lot selection shortcut buttons ---

  it("Select All button selects all pending lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Deselect both first
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    expect(screen.getAllByText("You are voting for 0 lots.")[0]).toBeInTheDocument();
    // Click Select All
    await user.click(screen.getByRole("button", { name: "Select all lots" }));
    expect(screen.getAllByText("You are voting for 2 lots.")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select All clears the no-selection error", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Deselect both, trigger error
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Click Select All — error should clear
    await user.click(screen.getByRole("button", { name: "Select all lots" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Deselect All button unchecks all lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    expect(screen.getAllByText("You are voting for 2 lots.")[0]).toBeInTheDocument();
    // Click Deselect All
    await user.click(screen.getByRole("button", { name: "Deselect all lots" }));
    expect(screen.getAllByText("You are voting for 0 lots.")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Proxy Lots button only shown when there is a proxy lot and selects only proxy lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Button should be visible when there's a proxy lot
    const proxyBtn = screen.getByRole("button", { name: "Select proxy lots only" });
    expect(proxyBtn).toBeInTheDocument();
    // Click it — only lo2 (proxy) should be selected
    await user.click(proxyBtn);
    expect(screen.getAllByText("You are voting for 1 lot.")[0]).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).not.toBeChecked(); // lo1 (not proxy) unchecked
    expect(checkboxes[1]).toBeChecked(); // lo2 (proxy) checked
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Proxy Lots clears the no-selection error", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Deselect both, trigger error
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Click Select Proxy Lots — error should clear
    await user.click(screen.getByRole("button", { name: "Select proxy lots only" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Owned Lots button only shown when there is a proxy lot and selects only owned lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Button should be visible when there's a proxy lot
    const ownedBtn = screen.getByRole("button", { name: "Select owned lots only" });
    expect(ownedBtn).toBeInTheDocument();
    // Click it — only lo1 (owned) should be selected
    await user.click(ownedBtn);
    expect(screen.getAllByText("You are voting for 1 lot.")[0]).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked(); // lo1 (owned) checked
    expect(checkboxes[1]).not.toBeChecked(); // lo2 (proxy) unchecked
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Owned Lots clears the no-selection error", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Deselect both, trigger error
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Click Select Owned Lots — error should clear
    await user.click(screen.getByRole("button", { name: "Select owned lots only" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Proxy/Owned Lots buttons NOT shown when there are no proxy lots", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    expect(screen.queryByRole("button", { name: "Select proxy lots only" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select owned lots only" })).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Proxy Lots ignores already-submitted lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: true, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo3", lot_number: "3", financial_position: "normal", already_submitted: false, is_proxy: true, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Select proxy lots only" }));
    // lo3 is proxy and pending → should be selected; lo2 is proxy but submitted → cannot be toggled
    expect(screen.getAllByText("You are voting for 1 lot.")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Owned Lots ignores already-submitted lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
        { lot_owner_id: "lo3", lot_number: "3", financial_position: "normal", already_submitted: false, is_proxy: true, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Select owned lots only" }));
    // lo2 is owned and pending → selected; lo1 is owned but submitted → not selectable
    expect(screen.getAllByText("You are voting for 1 lot.")[0]).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Mobile drawer (replaces inline sidebar toggle) ---

  it("drawer open button renders in multi-lot view", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // "☰ Your Lots" open button should be present
    expect(screen.getByRole("button", { name: "Open lot selector" })).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("drawer open button is NOT shown in single-lot non-proxy view", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    expect(screen.queryByRole("button", { name: "Open lot selector" })).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("clicking drawer open button renders the close button (drawer opens)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    const openBtn = screen.getByRole("button", { name: "Open lot selector" });
    await user.click(openBtn);
    // Close button should be visible inside the drawer
    expect(screen.getByRole("button", { name: "Close lot selector" })).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("clicking the close button inside the drawer closes it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Open
    await user.click(screen.getByRole("button", { name: "Open lot selector" }));
    expect(screen.getByRole("button", { name: "Close lot selector" })).toBeInTheDocument();
    // Close
    await user.click(screen.getByRole("button", { name: "Close lot selector" }));
    // Drawer is closed: backdrop should no longer be present
    expect(document.querySelector(".sidebar-drawer__backdrop")).not.toBeInTheDocument();
    // The drawer element is still in the DOM but now aria-hidden (close button hidden from role query)
    expect(document.querySelector(".sidebar-drawer")).toBeInTheDocument();
    expect(document.querySelector(".sidebar-drawer--open")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("clicking the backdrop closes the drawer", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Open drawer
    await user.click(screen.getByRole("button", { name: "Open lot selector" }));
    // Backdrop should be present
    const backdrop = document.querySelector(".sidebar-drawer__backdrop");
    expect(backdrop).toBeInTheDocument();
    // Click backdrop to close
    await user.click(backdrop!);
    // Backdrop should be gone after closing
    expect(document.querySelector(".sidebar-drawer__backdrop")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("drawer is not shown in single-lot non-proxy view (no showSidebar)", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // No drawer elements should be present
    expect(document.querySelector(".sidebar-drawer")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- No motions state ---

  it("shows no-motions message when server returns empty motions array", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([])
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("no-motions-message")).toBeInTheDocument();
    });
  });

  // --- Single-lot submitted View Submission in submit-section ---

  it("single-lot submitted: View Submission shown in submit-section when all motions already_voted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: true, submitted_choice: "no" },
        ])
      )
    );
    // Single non-proxy lot already submitted — no sidebar (showSidebar=false)
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] }])
    );
    renderPage();
    // "All voted" message and View Submission button should appear in submit-section (single-lot, no sidebar)
    await waitFor(() => {
      expect(screen.getByTestId("all-voted-message")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "View Submission" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Per-lot per-motion locking (BUG-RV-03 / Phase 3) ---

  it("motion is read-only when all selected lots have it in voted_motion_ids", async () => {
    // Both lots have voted on MOTION_ID_1 → it should be locked (read-only)
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // Motion 1: both lots have it in voted_motion_ids → read-only badge shown
    expect(screen.getAllByText("✓ Already voted")[0]).toBeInTheDocument();
    // Motion 2: neither lot has it in voted_motion_ids → no read-only badge
    const alreadyVotedBadges = screen.queryAllByText("✓ Already voted");
    expect(alreadyVotedBadges).toHaveLength(1);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("motion is NOT read-only when only some selected lots have voted on it", async () => {
    // Lo1 has voted on MOTION_ID_1, lo2 has not → motion remains interactive
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: false, submitted_choice: null },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // lo2 has not voted on MOTION_ID_1 → not read-only
    expect(screen.queryByText("✓ Already voted")).not.toBeInTheDocument();
    // Vote buttons should be enabled
    const forButtons = screen.getAllByRole("button", { name: "For" });
    expect(forButtons[0]).not.toBeDisabled();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("motion is NOT read-only when selectedLots is empty", async () => {
    // No lots in sessionStorage → selectedLots = [] → isMotionReadOnly returns false
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
        ])
      )
    );
    // No sessionStorage lots → allLots is empty → selectedLots is empty
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // No read-only badge — empty selectedLots means isMotionReadOnly returns false
    expect(screen.queryByText("✓ Already voted")).not.toBeInTheDocument();
  });

  // --- Revote scenario tests (BUG-RV-01) ---
  // Submit button must be visible when all lots have already_submitted=true but new visible
  // motions exist that haven't been voted on yet (i.e. unvotedMotions.length > 0).

  it("revote: submit button IS visible when lot voted_motion_ids is partial but new motions exist", async () => {
    // Simulate the revote scenario: lot has voted on MOTION_ID_1 (in voted_motion_ids),
    // but a new MOTION_ID_2 is now visible and not yet voted on → submit button must be visible.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "New Motion", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    // Lot has voted on MOTION_ID_1 but not MOTION_ID_2
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    // MOTION_ID_1 is locked (only motion in voted_motion_ids), MOTION_ID_2 is interactive
    // unvotedMotions = [MOTION_ID_2] → Submit button must be visible
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("revote: submit button hidden when all motions in voted_motion_ids for all selected lots", async () => {
    // When all motions are in voted_motion_ids for the lot → all read-only → no submit button.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: true, submitted_choice: "no" },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // No submit button — all motions read-only
    expect(screen.queryByRole("button", { name: "Submit ballot" })).not.toBeInTheDocument();
    // View Submission shown instead (single non-proxy lot, no sidebar, all motions read-only)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot all-submitted: View Submission not duplicated in submit-section when sidebar present", async () => {
    // When showSidebar=true (multi-lot), the submit-section should not render a second View Submission button
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: true, submitted_choice: "no" },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    // Exactly one View Submission button (from sidebar only, not duplicated in submit-section)
    const viewSubmissionButtons = screen.getAllByRole("button", { name: "View Submission" });
    expect(viewSubmissionButtons).toHaveLength(1);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- After successful submit: state and sessionStorage update (BUG-LS-01 regression) ---

  it("after submit: submitted lots are marked already_submitted and show disabled checkbox and badge", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    // Seed the submitted lot IDs (simulating what handleSubmitClick writes)
    sessionStorage.setItem(`meeting_lots_${AGM_ID}`, JSON.stringify(["lo1", "lo2"]));
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));

    // Submit ballot
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    // After navigation mock fires, submitted lots are marked already_submitted
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    // Both checkboxes should be disabled (getAllByRole returns all checkboxes across sidebar + drawer,
    // but each lot appears once per panel; check that all rendered checkboxes are disabled)
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((cb) => expect(cb).toBeDisabled());

    // "Already submitted" badges shown — lot list content is rendered in both sidebar and drawer
    // so each lot produces 2 badge elements (1 per panel); at minimum 2 unique lots' badges exist
    const badges = screen.getAllByText("Already submitted");
    expect(badges.length).toBeGreaterThanOrEqual(2);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  it("after submit: sessionStorage meeting_lots_info is updated with already_submitted: true for submitted lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    sessionStorage.setItem(`meeting_lots_${AGM_ID}`, JSON.stringify(["lo1", "lo2"]));
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    // sessionStorage meeting_lots_info should have both lots marked as already_submitted
    const stored = JSON.parse(
      sessionStorage.getItem(`meeting_lots_info_${AGM_ID}`) ?? "[]"
    ) as { lot_owner_id: string; already_submitted: boolean }[];
    const lo1 = stored.find((l) => l.lot_owner_id === "lo1");
    const lo2 = stored.find((l) => l.lot_owner_id === "lo2");
    expect(lo1?.already_submitted).toBe(true);
    expect(lo2?.already_submitted).toBe(true);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  it("after partial submit: remaining unsubmitted lot stays selectable", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo3", lot_number: "3", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));

    // Deselect lo3 so that handleSubmitClick only writes ["lo1","lo2"] to sessionStorage
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[2]); // uncheck lo3

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    // After onSuccess: lo1 and lo2 are disabled (submitted), lo3 is still enabled
    const updatedCheckboxes = screen.getAllByRole("checkbox");
    // There are 3 lots × 2 panels (sidebar + drawer) = 6 checkboxes rendered in DOM
    // Check by aria-label to target specific lots unambiguously
    const lo1Checkboxes = screen.getAllByLabelText("Lot 1");
    const lo2Checkboxes = screen.getAllByLabelText("Lot 2");
    const lo3Checkboxes = screen.getAllByLabelText("Lot 3");
    lo1Checkboxes.forEach((cb) => expect(cb).toBeDisabled());
    lo2Checkboxes.forEach((cb) => expect(cb).toBeDisabled());
    lo3Checkboxes.forEach((cb) => expect(cb).not.toBeDisabled());

    // Silence unused variable warning
    expect(updatedCheckboxes.length).toBeGreaterThan(0);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  it("back navigation with updated sessionStorage: submitted lots render as disabled (regression)", async () => {
    // Simulate the post-fix state: sessionStorage has already_submitted: true AND voted_motion_ids
    // covering all current motions (as written by onSuccess after a submit).
    // Under the BUG-NM-01-B fix, isLotSubmitted derives from voted_motion_ids + motions.
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));

    // All rendered checkboxes should be disabled (lot list is rendered in both sidebar and drawer)
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((cb) => expect(cb).toBeDisabled());

    // "Already submitted" badges shown for each lot in each panel
    const badges = screen.getAllByText("Already submitted");
    expect(badges.length).toBeGreaterThanOrEqual(2);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("after submit with no meeting_lots sessionStorage: falls back to empty submittedIds (no lots marked)", async () => {
    // Edge case: meeting_lots_<id> is absent when onSuccess fires
    // This can happen for single-lot voters where handleSubmitClick does not write the key.
    // Single-lot non-proxy voters: allLots is empty (no sessionStorage lot info), isMultiLot=false,
    // handleSubmitClick does not write meeting_lots_<id>, so onSuccess reads null → submittedIds=[]
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    // Wait for motions to load before interacting
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }), { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("after submit: invalid JSON in meeting_lots_info sessionStorage is handled gracefully (catch branch)", async () => {
    // Edge case: meeting_lots_info_<id> contains invalid JSON when onSuccess fires.
    // The synchronous sessionStorage write in onSuccess must not throw — it must catch the
    // parse error and leave sessionStorage unchanged (BUG-AS-01 catch path).
    sessionStorage.setItem(`meeting_lots_info_${AGM_ID}`, "invalid-json{{{");
    sessionStorage.setItem(`meeting_lots_${AGM_ID}`, JSON.stringify(["lo1"]));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    // allLots is empty because sessionStorage has invalid JSON (parse error in useEffect)
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    // Navigate still fires — the catch block does not rethrow
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  // --- BUG-RV-02: Pre-populate prior vote choices on re-entry ---

  it("choices seeded from submitted_choice when motions load (revote scenario — locked motion)", async () => {
    // When a voter re-enters and the motion is LOCKED (lot's voted_motion_ids contains the
    // motion), the submitted_choice should be pre-populated. If the motion is not locked,
    // no pre-fill should occur (see separate tests below).
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    // lot has voted on MOTION_ID_1 → it is locked → pre-fill is allowed
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] }])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // Motion 1 is locked — its For button should be aria-pressed="true"
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "true");
    });
    // Motion 2 has submitted_choice=null — its For button should be aria-pressed="false"
    const forButtons = screen.getAllByRole("button", { name: "For" });
    expect(forButtons[1]).toHaveAttribute("aria-pressed", "false");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("choices NOT seeded for unlocked motion even when already_voted=true", async () => {
    // Unlocked motion (lot has not voted on it, voted_motion_ids is empty) must start blank
    // even if already_voted=true and submitted_choice is not null.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    // lot has voted_motion_ids: [] → no motion is locked → no pre-fill should happen
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] }])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // Motion 1 is unlocked — For button must NOT be pre-filled
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "false");
      expect(forButtons[1]).toHaveAttribute("aria-pressed", "false");
    });
    // Progress bar shows 0 / 2 (Motion 1 is unlocked so it counts toward the total)
    expect(screen.getByLabelText("0 / 2 motions answered")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("choices seeded for locked motion (all selected lots voted)", async () => {
    // Both motions are locked (lot has voted on both) — both submitted_choices should be seeded.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: true, submitted_choice: "no" },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // Both motions are locked — submitted choices must be pre-filled
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      const againstButtons = screen.getAllByRole("button", { name: "Against" });
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "true");   // Motion 1 = "yes"
      expect(againstButtons[1]).toHaveAttribute("aria-pressed", "true"); // Motion 2 = "no"
    });
    // Both cards show "✓ Already voted" badge (read-only, non-colour cue)
    const alreadyVotedBadges = screen.getAllByText("✓ Already voted");
    expect(alreadyVotedBadges).toHaveLength(2);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("partial lock: locked motion pre-filled, unlocked motion starts blank", async () => {
    // Motion 1 is locked (in voted_motion_ids), Motion 2 is unlocked (not in voted_motion_ids).
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      // Motion 1 is locked → pre-filled as "yes"
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "true");
      // Motion 2 is unlocked → no pre-fill
      expect(forButtons[1]).toHaveAttribute("aria-pressed", "false");
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: locked only when ALL selected lots voted — unlocked motion starts blank", async () => {
    // Lot A fully submitted (both motions in voted_motion_ids).
    // Lot B pending (no motions voted). selectedIds will contain only Lot B.
    // For Lot B's reference set, neither motion is locked → no pre-fill.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo-A", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo-B", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // selectedIds = {lo-B} because Lot A is submitted. Lot B has no voted motions → no motion locked.
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "false");
      expect(forButtons[1]).toHaveAttribute("aria-pressed", "false");
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("submitted_choice not seeded when already_voted is false (null choice)", async () => {
    // Motions with already_voted=false and submitted_choice=null must not be seeded.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: false, submitted_choice: null },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("button", { name: "For" }));
    const forButtons = screen.getAllByRole("button", { name: "For" });
    expect(forButtons[0]).toHaveAttribute("aria-pressed", "false");
    expect(forButtons[1]).toHaveAttribute("aria-pressed", "false");
    // Progress bar shows 0 answered
    expect(screen.getByLabelText("0 / 2 motions answered")).toBeInTheDocument();
  });

  it("existing user interaction not overwritten by submitted_choice seeding", async () => {
    // If a voter has already clicked a button in the current session, and motions reload
    // (e.g. due to query invalidation), the seeding must not overwrite their selection.
    // Under the new behaviour, unlocked motions are never seeded, so the test verifies
    // that a user-set choice on an unlocked motion is preserved if the effect re-fires.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    // lot has voted_motion_ids: [] → Motion 1 is unlocked → seeding does NOT seed it
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] }])
    );
    renderPage();
    // Motion 1 is unlocked → not pre-seeded → For button starts as unpressed
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "false");
    });
    // User selects "Against" for Motion 1
    const noButtons = screen.getAllByRole("button", { name: "Against" });
    await user.click(noButtons[0]);
    await waitFor(() => {
      expect(noButtons[0]).toHaveAttribute("aria-pressed", "true");
    });
    // The seeding guard (!(m.id in seeded)) means if motions re-resolves, Motion 1's "no" is kept.
    // We can verify this: the For button for Motion 1 remains unpressed (the "no" choice persists).
    const forButtons = screen.getAllByRole("button", { name: "For" });
    expect(forButtons[0]).toHaveAttribute("aria-pressed", "false");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("all-voted message shown when all motions have already_voted=true (no sidebar)", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: true, submitted_choice: "no" },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("all-voted-message")).toBeInTheDocument();
      expect(screen.getByTestId("all-voted-message")).toHaveTextContent("You have voted on all motions.");
    });
    // No submit button
    expect(screen.queryByRole("button", { name: "Submit ballot" })).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("all-voted message NOT shown when there are unvoted motions", async () => {
    // Default fixture has already_voted=false for both motions
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    expect(screen.queryByTestId("all-voted-message")).not.toBeInTheDocument();
  });

  // --- Mixed selection warning (BUG-RV-04 / Phase 3) ---

  it("mixed warning NOT shown for single-lot voter", async () => {
    // Single lot → no mixed state possible → proceed directly to SubmitDialog
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    // Should go straight to SubmitDialog — no mixed warning
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Mixed voting history" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("mixed warning NOT shown when all selected lots have same voted_motion_ids (all fresh)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    // Both lots are fresh → no mixed state → proceed to SubmitDialog
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Mixed voting history" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("mixed warning NOT shown when all selected lots have same voted_motion_ids (all partial same)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    // Both lots have same coverage → no mixed state
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Mixed voting history" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("mixed warning IS shown when selected lots have different voted_motion_ids", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    // Mixed state: lo1 has voted on MOTION_ID_1, lo2 has not → warning shown
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Mixed voting history" })).toBeInTheDocument();
    });
    // Warning dialog must be visible
    expect(screen.getByText(/previously submitted votes will not be changed/)).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("mixed warning Continue proceeds to SubmitDialog", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("heading", { name: "Mixed voting history" }));
    // Click Continue
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Mixed warning should be dismissed and SubmitDialog should appear
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Mixed voting history" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("mixed warning Go back dismisses warning and returns to voting", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("button", { name: "Submit ballot" }));
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("heading", { name: "Mixed voting history" }));
    // Click Go back
    await user.click(screen.getByRole("button", { name: "Go back to lot selection" }));
    // Warning dismissed, no dialog shown
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Mixed voting history" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Submit ballot button still visible (still on voting page)
    expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- BUG-NM-01-B: Dynamic already_submitted derivation (Option C fix) ---

  // --- Happy path ---

  it("isLotSubmitted: lot unlocks when motions array is empty (no motions loaded yet)", async () => {
    // When motions have not yet loaded, isLotSubmitted returns false — lots stay selectable.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        // Simulate slow server — motions load after a delay; use empty for this test
        HttpResponse.json([])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );
    renderPage();
    // With empty motions, no-motions message shown; lot panel is not multi-lot (single lot), no sidebar
    await waitFor(() => {
      expect(screen.getByTestId("no-motions-message")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("isLotSubmitted: lot is locked when all motions are in voted_motion_ids", async () => {
    // Both motions are in voted_motion_ids → isLotSubmitted returns true → disabled checkbox
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    // Wait for motions to load so isLotSubmitted can evaluate
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    // lo1 has both motions in voted_motion_ids → checkbox disabled
    const lo1Checkboxes = screen.getAllByLabelText("Lot 1");
    lo1Checkboxes.forEach((cb) => expect(cb).toBeDisabled());
    // lo2 has no voted_motion_ids → checkbox enabled
    const lo2Checkboxes = screen.getAllByLabelText("Lot 2");
    lo2Checkboxes.forEach((cb) => expect(cb).not.toBeDisabled());
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("isLotSubmitted: lot stays unlocked when only partial voted_motion_ids (new motion added)", async () => {
    // Simulates BUG-NM-01-B: lot was previously fully submitted (voted_motion_ids=[MOTION_ID_1]),
    // but admin now reveals MOTION_ID_2. isLotSubmitted returns false — lot should be unlocked.
    // The [motions, allLots] effect should add lo1 back to selectedIds.
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    // After motions load: MOTION_ID_2 is NOT in lo1's voted_motion_ids
    // isLotSubmitted(lo1) = false → checkbox should be enabled
    await waitFor(() => {
      const lo1Checkboxes = screen.getAllByLabelText("Lot 1");
      lo1Checkboxes.forEach((cb) => expect(cb).not.toBeDisabled());
    });
    // No "Already submitted" badge for lo1
    const allBadges = screen.queryAllByText("Already submitted");
    expect(allBadges).toHaveLength(0);
    // Submit ballot button visible (unvotedMotions > 0)
    expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("BUG-NM-01-B regression: lot unlocks on re-mount when new motion exists", async () => {
    // Simulates voter returning to VotingPage after unmount (e.g. navigated to confirmation then back).
    // sessionStorage has already_submitted: true (stale), voted_motion_ids=[MOTION_ID_1] (partial).
    // A new MOTION_ID_2 was revealed by admin. The re-mount should show the lot as unlocked.
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true, submitted_choice: "yes" },
          { id: MOTION_ID_2, title: "New Motion", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false, submitted_choice: null },
        ])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        // Stale state from a previous submit: already_submitted=true but only MOTION_ID_1 in voted_motion_ids
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    // isLotSubmitted(lo1) = motions.every(m => [MOTION_ID_1].includes(m.id))
    // = [MOTION_ID_1, MOTION_ID_2].every(...) = false (MOTION_ID_2 not in voted_motion_ids)
    // → lot should NOT show "Already submitted" badge
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    expect(screen.queryByText("Already submitted")).not.toBeInTheDocument();
    // Submit ballot button must be present
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
    });
    // Motion 1 should be pre-filled (already_voted=true, submitted_choice="yes")
    await waitFor(() => {
      const forButtons = screen.getAllByRole("button", { name: "For" });
      expect(forButtons[0]).toHaveAttribute("aria-pressed", "true");
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("after submit: voted_motion_ids is merged in sessionStorage for submitted lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    sessionStorage.setItem(`meeting_lots_${AGM_ID}`, JSON.stringify(["lo1", "lo2"]));
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    // sessionStorage voted_motion_ids for submitted lots must include current motion IDs
    const stored = JSON.parse(
      sessionStorage.getItem(`meeting_lots_info_${AGM_ID}`) ?? "[]"
    ) as { lot_owner_id: string; voted_motion_ids: string[] }[];
    const lo1 = stored.find((l) => l.lot_owner_id === "lo1");
    const lo2 = stored.find((l) => l.lot_owner_id === "lo2");
    expect(lo1?.voted_motion_ids).toContain(MOTION_ID_1);
    expect(lo1?.voted_motion_ids).toContain(MOTION_ID_2);
    expect(lo2?.voted_motion_ids).toContain(MOTION_ID_1);
    expect(lo2?.voted_motion_ids).toContain(MOTION_ID_2);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  it("after partial submit: voted_motion_ids only merged for submitted lots, not unsubmitted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    // Only lo1 is being submitted
    sessionStorage.setItem(`meeting_lots_${AGM_ID}`, JSON.stringify(["lo1"]));
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));

    // Deselect lo2 (checkbox 1) before submitting
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);

    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    const stored = JSON.parse(
      sessionStorage.getItem(`meeting_lots_info_${AGM_ID}`) ?? "[]"
    ) as { lot_owner_id: string; voted_motion_ids: string[] }[];
    const lo1 = stored.find((l) => l.lot_owner_id === "lo1");
    const lo2 = stored.find((l) => l.lot_owner_id === "lo2");
    // lo1 (submitted) should have voted_motion_ids updated
    expect(lo1?.voted_motion_ids).toContain(MOTION_ID_1);
    // lo2 (not submitted) should have empty voted_motion_ids
    expect(lo2?.voted_motion_ids).toHaveLength(0);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  // --- restoreSession on mount (via HttpOnly cookie) ---

  it("restoreSession is always called on mount via cookie (no localStorage needed)", async () => {
    // Session restore is triggered on every mount — the agm_session cookie is sent
    // automatically by the browser, so no localStorage token check is needed.
    const restoreSessionSpy = vi.spyOn(voterApi, "restoreSession").mockResolvedValue({
      lots: [
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ],
      voter_email: "owner@example.com",
      agm_status: "open",
      building_name: "Sunset Towers",
      meeting_title: "2024 AGM",
      unvoted_visible_count: 2,
      session_token: "refreshed-token",
    });
    renderPage();
    await waitFor(() => {
      expect(restoreSessionSpy).toHaveBeenCalledWith({
        general_meeting_id: AGM_ID,
      });
    });
    restoreSessionSpy.mockRestore();
  });

  it("restoreSession failure is handled gracefully: page still renders", async () => {
    const restoreSessionSpy = vi.spyOn(voterApi, "restoreSession").mockRejectedValue(
      new Error("Session expired")
    );
    renderPage();
    // Page should still render motions normally after the rejection
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    restoreSessionSpy.mockRestore();
  });

  it("restoreSession updates allLots and sessionStorage with fresh voted_motion_ids", async () => {
    // Simulate: sessionStorage has stale lots with voted_motion_ids=[MOTION_ID_1] (partial),
    // but server returns fresh lots with voted_motion_ids=[] (new motion added by admin).
    // restoreSession should update allLots so isLotSubmitted can re-evaluate correctly.
    const freshLots = [
      { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
    ];
    vi.spyOn(voterApi, "restoreSession").mockResolvedValue({
      lots: freshLots,
      voter_email: "owner@example.com",
      agm_status: "open",
      building_name: "Sunset Towers",
      meeting_title: "2024 AGM",
      unvoted_visible_count: 2,
      session_token: "refreshed-token",
    });
    // Stale sessionStorage: both lots marked as already_submitted with old voted_motion_ids
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1] },
      ])
    );
    renderPage();
    // After restoreSession: fresh lots have voted_motion_ids=[] → isLotSubmitted returns false
    // → lots should be unlocked (Submit ballot button visible)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
    });
    // sessionStorage should be updated with fresh data
    await waitFor(() => {
      const stored = JSON.parse(
        sessionStorage.getItem(`meeting_lots_info_${AGM_ID}`) ?? "[]"
      ) as { lot_owner_id: string; voted_motion_ids: string[] }[];
      expect(stored[0]?.voted_motion_ids).toHaveLength(0);
      expect(stored[1]?.voted_motion_ids).toHaveLength(0);
    });
    vi.restoreAllMocks();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Edge cases ---

  it("isLotSubmitted: no voted_motion_ids property (undefined) treated as empty", async () => {
    // LotInfo without voted_motion_ids — should default to [] via ?? [] fallback
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    // Without voted_motion_ids, isLotSubmitted returns false — all checkboxes enabled
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((cb) => expect(cb).not.toBeDisabled());
    expect(screen.queryByText("Already submitted")).not.toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("selectedIds re-seeded: fully-submitted lots excluded after [motions, allLots] effect fires", async () => {
    // Start with all lots appearing unsubmitted (empty voted_motion_ids), then
    // simulate a re-render where one lot has voted_motion_ids covering all motions.
    // After the effect: that lot is removed from selectedIds.
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    // After motions load and effect fires:
    // - lo1: voted_motion_ids covers all motions → removed from selectedIds → checkbox disabled
    // - lo2: voted_motion_ids empty → stays in selectedIds → checkbox enabled
    await waitFor(() => {
      expect(screen.getAllByText("You are voting for 1 lot.")[0]).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Multi-choice motion type ---

  it("renders multi-choice motion checkboxes when motion_type is multi_choice", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([mcMotionFixtureVoter])
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Alice")).toBeInTheDocument();
      expect(screen.getByLabelText("Bob")).toBeInTheDocument();
      expect(screen.getByLabelText("Carol")).toBeInTheDocument();
    });
  });

  it("counts multi-choice motion as answered when user interacts with it", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([mcMotionFixtureVoter])
      )
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    sessionStorage.setItem(
      `meeting_lots_${AGM_ID}`,
      JSON.stringify(["lo-e2e"])
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo-e2e", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Alice")).toBeInTheDocument();
    });
    // Initially 0/1 answered
    expect(screen.getByText("0 / 1")).toBeInTheDocument();
    // Click Alice checkbox
    await user.click(screen.getByLabelText("Alice"));
    // Now 1/1 answered
    await waitFor(() => {
      expect(screen.getByText("1 / 1")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("highlights multi-choice motion as unanswered when submit clicked without answering", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([mcMotionFixtureVoter])
      )
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    sessionStorage.setItem(
      `meeting_lots_${AGM_ID}`,
      JSON.stringify(["lo-e2e"])
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo-e2e", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Alice")).toBeInTheDocument();
    });
    // Click submit without selecting any MC option
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    // The submit dialog should appear (we haven't answered the MC motion — treated as unanswered)
    // The dialog appears because unvotedMotions.length > 0
    await waitFor(() => {
      // Either the dialog shows or the unanswered highlight appears
      const highlightedCard = document.querySelector(".motion-card--highlight");
      expect(highlightedCard).toBeInTheDocument();
    });
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("seeds multiChoiceSelections from submitted_option_ids when MC motion is read-only", async () => {
    // Fix 2: when the voter returns to the page and the MC motion is already voted,
    // submitted_option_ids should restore the option checkboxes in read-only state.
    const votedMcMotion = {
      ...mcMotionFixtureVoter,
      already_voted: true,
      submitted_choice: "selected" as const,
      submitted_option_ids: ["opt-alice", "opt-bob"],
    };
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([votedMcMotion])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        {
          lot_owner_id: "lo-e2e",
          lot_number: "1",
          financial_position: "normal",
          already_submitted: true,
          is_proxy: false,
          voted_motion_ids: [MOTION_ID_MC],
        },
      ])
    );
    renderPage();
    await waitFor(() => {
      // Alice and Bob checkboxes should be checked (seeded from submitted_option_ids)
      expect(screen.getByLabelText("Alice")).toBeChecked();
      expect(screen.getByLabelText("Bob")).toBeChecked();
    });
    // Carol should not be checked
    expect(screen.getByLabelText("Carol")).not.toBeChecked();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("does not seed multiChoiceSelections when MC motion is not read-only", async () => {
    // When the lot has not yet voted on the MC motion, submitted_option_ids
    // should NOT pre-populate checkboxes even if the field is present.
    const unvotedMcMotion = {
      ...mcMotionFixtureVoter,
      already_voted: false,
      submitted_choice: null,
      submitted_option_ids: ["opt-alice"],  // should be ignored (motion not read-only)
    };
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([unvotedMcMotion])
      )
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        {
          lot_owner_id: "lo-e2e",
          lot_number: "1",
          financial_position: "normal",
          already_submitted: false,
          is_proxy: false,
          voted_motion_ids: [],
        },
      ])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Alice")).toBeInTheDocument();
    });
    // Alice checkbox should NOT be pre-checked since the motion is interactive
    expect(screen.getByLabelText("Alice")).not.toBeChecked();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("includes multi_choice_votes in submit payload", async () => {
    const submitSpy = vi.spyOn(voterApi, "submitBallot").mockResolvedValue({
      submitted: true,
      lots: [],
    });
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
        HttpResponse.json([mcMotionFixtureVoter])
      )
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
    sessionStorage.setItem(
      `meeting_lots_${AGM_ID}`,
      JSON.stringify(["lo-e2e"])
    );
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo-e2e", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false, voted_motion_ids: [] },
      ])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Alice")).toBeInTheDocument();
    });
    // Select Alice
    await user.click(screen.getByLabelText("Alice"));
    // Now submit
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    // Confirm dialog — the dialog submit button is also "Submit ballot"
    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: "Submit ballot" });
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
    // Click the last "Submit ballot" button (inside the dialog)
    const submitButtons = screen.getAllByRole("button", { name: "Submit ballot" });
    await user.click(submitButtons[submitButtons.length - 1]);

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(
        AGM_ID,
        expect.objectContaining({
          multi_choice_votes: expect.arrayContaining([
            expect.objectContaining({
              motion_id: MOTION_ID_MC,
              option_ids: ["opt-alice"],
            }),
          ]),
        })
      );
    });
    submitSpy.mockRestore();
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });
});
