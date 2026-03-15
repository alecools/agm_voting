import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { VotingPage } from "../VotingPage";
import { AGM_ID, BUILDING_ID, MOTION_ID_1, MOTION_ID_2 } from "../../../../tests/msw/handlers";
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
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}`);
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
    expect(screen.getByText("via Proxy")).toBeInTheDocument();
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
      JSON.stringify([{ lot_owner_id: "lo1", lot_number: "99", financial_position: "normal", already_submitted: true, is_proxy: true }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Already submitted")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View Submission" }));
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
    expect(screen.getByText("You are voting for 2 lots.")).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    // Motions are immediately visible — no Start Voting gate
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
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
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
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
    expect(screen.getByText("via Proxy")).toBeInTheDocument();
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
    expect(screen.getByText("In Arrear")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("multi-lot: already-submitted lot has disabled checkbox and submitted badge", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[1]).toBeDisabled();
    expect(screen.getByText("Already submitted")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("all-submitted lots (multi-lot): shows View Submission button", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));
    expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Voting" })).not.toBeInTheDocument();
    expect(screen.getByText("All lots have been submitted.")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("all-submitted lots (multi-lot): View Submission button navigates to confirmation", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false },
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
          { id: MOTION_ID_1, title: "Motion 1", description: null, order_index: 0, motion_type: "general" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, order_index: 1, motion_type: "special" },
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
          { id: MOTION_ID_1, title: "General Motion", description: null, order_index: 0, motion_type: "general" },
          { id: MOTION_ID_2, title: "Special Motion", description: null, order_index: 1, motion_type: "special" },
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
    expect(screen.getByText("You are voting for 0 lots.")).toBeInTheDocument();
    // Click Select All
    await user.click(screen.getByRole("button", { name: "Select all lots" }));
    expect(screen.getByText("You are voting for 2 lots.")).toBeInTheDocument();
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
    expect(screen.getByText("You are voting for 2 lots.")).toBeInTheDocument();
    // Click Deselect All
    await user.click(screen.getByRole("button", { name: "Deselect all lots" }));
    expect(screen.getByText("You are voting for 0 lots.")).toBeInTheDocument();
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
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
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
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
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
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: true },
        { lot_owner_id: "lo3", lot_number: "3", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Select proxy lots only" }));
    // lo3 is proxy and pending → should be selected; lo2 is proxy but submitted → cannot be toggled
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("Select Owned Lots ignores already-submitted lots", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo3", lot_number: "3", financial_position: "normal", already_submitted: false, is_proxy: true },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Select owned lots only" }));
    // lo2 is owned and pending → selected; lo1 is owned but submitted → not selectable
    expect(screen.getByText("You are voting for 1 lot.")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  // --- Sidebar toggle (mobile collapsible) ---

  it("sidebar toggle button renders in multi-lot view", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getAllByRole("checkbox"));
    // Toggle button with aria-expanded should be present
    const toggleBtn = screen.getByRole("button", { name: /Your Lots/ });
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("sidebar toggle expands and collapses the list", async () => {
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
    const toggleBtn = screen.getByRole("button", { name: /Your Lots/ });
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    // Click to expand
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    // Click again to collapse
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("sidebar toggle summary shows selected count", async () => {
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
    // Initially 2 lots selected
    expect(screen.getByText("Your Lots (2 selected)")).toBeInTheDocument();
    // Deselect one
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    expect(screen.getByText("Your Lots (1 selected)")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });

  it("sidebar toggle summary says 'all submitted' when all lots are submitted", async () => {
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: true, is_proxy: false },
      ])
    );
    renderPage();
    await waitFor(() => screen.getByText("All lots have been submitted."));
    expect(screen.getByText("Your Lots — all submitted")).toBeInTheDocument();
    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
  });
});
