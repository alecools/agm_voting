import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { VotingPage } from "../VotingPage";
import { AGM_ID, BUILDING_ID, MOTION_ID_1, MOTION_ID_2 } from "../../../../tests/msw/handlers";

const BASE = "http://localhost:8000";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(agmId = AGM_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/vote/${agmId}/voting`]}>
        <Routes>
          <Route path="/vote/:agmId/voting" element={<VotingPage />} />
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

  it("restores draft selections on load", async () => {
    server.use(
      http.get(`${BASE}/api/agm/${AGM_ID}/drafts`, () =>
        HttpResponse.json({
          drafts: [{ motion_id: MOTION_ID_1, choice: "yes" }],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      const yesButtons = screen.getAllByRole("button", { name: "For" });
      expect(yesButtons[0]).toHaveAttribute("aria-pressed", "true");
    });
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
      http.post(`${BASE}/api/agm/${AGM_ID}/submit`, () =>
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
      http.post(`${BASE}/api/agm/${AGM_ID}/submit`, () =>
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
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () =>
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
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () =>
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

  it("auto-saves after selecting a choice", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    const yesButtons = await waitFor(() => screen.getAllByRole("button", { name: "For" }));
    await user.click(yesButtons[0]);
    act(() => { vi.advanceTimersByTime(400); });
    await waitFor(() => {
      expect(screen.getAllByText(/Saved/).length).toBeGreaterThan(0);
    });
  });

  it("poll finds open AGM (no status change - stays open)", async () => {
    // AGM remains open in poll — the `if (found) return` branch
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () =>
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
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () => HttpResponse.error())
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));

    act(() => { vi.advanceTimersByTime(11000); });

    // Error in poll catch — should still be on voting page
    expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
  });

  it("handles fetch error during initial building lookup", async () => {
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () => HttpResponse.error())
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

  it("back button navigates to lot-selection page", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/lot-selection`);
  });

  // --- in-arrear lot tests ---

  it("shows in-arrear notice when lot info has in-arrear lots", async () => {
    // Set up motions with motion_type
    server.use(
      http.get(`${BASE}/api/agm/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, order_index: 0, motion_type: "general" },
          { id: MOTION_ID_2, title: "Motion 2", description: null, order_index: 1, motion_type: "special" },
        ])
      )
    );
    sessionStorage.setItem(
      `agm_lot_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo-1", lot_number: "5A", financial_position: "in_arrear", already_submitted: false }])
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("in-arrear-notice")).toBeInTheDocument();
      expect(screen.getByText(/5A.*are in arrear/)).toBeInTheDocument();
    });
    sessionStorage.removeItem(`agm_lot_info_${AGM_ID}`);
  });

  it("shows in-arrear modal when clicking locked general motion button", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    server.use(
      http.get(`${BASE}/api/agm/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, order_index: 0, motion_type: "general" },
        ])
      )
    );
    sessionStorage.setItem(
      `agm_lot_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo-1", lot_number: "5A", financial_position: "in_arrear", already_submitted: false }])
    );
    renderPage();
    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));

    // Click the "For" button on the locked general motion
    const forButton = screen.getByRole("button", { name: "For" });
    await user.click(forButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText(/Can't vote on General Motion as financial position is in arrear/)).toBeInTheDocument();
    });

    // Dismiss the modal
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    sessionStorage.removeItem(`agm_lot_info_${AGM_ID}`);
  });

  it("counts in-arrear general motions as answered in progress bar", async () => {
    server.use(
      http.get(`${BASE}/api/agm/${AGM_ID}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "General Motion", description: null, order_index: 0, motion_type: "general" },
          { id: MOTION_ID_2, title: "Special Motion", description: null, order_index: 1, motion_type: "special" },
        ])
      )
    );
    sessionStorage.setItem(
      `agm_lot_info_${AGM_ID}`,
      JSON.stringify([{ lot_owner_id: "lo-1", lot_number: "5A", financial_position: "in_arrear", already_submitted: false }])
    );
    renderPage();
    // General motion is auto-answered, so 1/2 answered from the start
    await waitFor(() => {
      expect(screen.getByLabelText("1 / 2 motions answered")).toBeInTheDocument();
    });
    sessionStorage.removeItem(`agm_lot_info_${AGM_ID}`);
  });

  it("handles invalid sessionStorage lot info gracefully", async () => {
    sessionStorage.setItem(`agm_lot_info_${AGM_ID}`, "not valid json");
    renderPage();
    // Should not crash, and no in-arrear notice should appear
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("in-arrear-notice")).not.toBeInTheDocument();
    sessionStorage.removeItem(`agm_lot_info_${AGM_ID}`);
  });
});
