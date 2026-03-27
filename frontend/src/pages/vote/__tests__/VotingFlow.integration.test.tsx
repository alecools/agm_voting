import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import App from "../../../App";
import { AGM_ID, BUILDING_ID } from "../../../../tests/msw/handlers";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderApp(initialPath = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const BASE = "http://localhost:8000";

describe("Voting Flow Integration", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Session restore fires on every AuthPage and VotingPage mount via the HttpOnly cookie.
    // Default to 401 so tests that navigate to these pages are not blocked by a restore redirect.
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({ detail: "Session expired or invalid" }, { status: 401 })
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("full lot owner journey: building select → AGM list appears", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderApp("/");

    // Wait for buildings to load
    await waitFor(() => screen.getByLabelText("Select your building"));

    // Select building
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);

    // AGM list should appear
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });

    // Open AGM has Enter Voting button
    expect(screen.getByRole("button", { name: "Enter Voting" })).toBeInTheDocument();
    // Closed AGM has View My Submission button
    expect(screen.getByRole("button", { name: "View My Submission" })).toBeInTheDocument();
  });

  it("auth page renders after navigating to /vote/:meetingId/auth", async () => {
    renderApp(`/vote/${AGM_ID}/auth`);
    await waitFor(() => {
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    });
  });

  it("voting page renders motions", async () => {
    renderApp(`/vote/${AGM_ID}/voting`);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Motion 2" })).toBeInTheDocument();
    });
  });

  it("confirmation page renders ballot", async () => {
    renderApp(`/vote/${AGM_ID}/confirmation`);
    await waitFor(() => {
      expect(screen.getByText(/owner@example.com/)).toBeInTheDocument();
    });
  });

  it("full submit flow: select all → submit → navigate to confirmation", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderApp(`/vote/${AGM_ID}/voting`);

    // Wait for motions
    await waitFor(() => screen.getAllByRole("button", { name: "For" }));

    // Answer all motions
    const yesButtons = screen.getAllByRole("button", { name: "For" });
    await user.click(yesButtons[0]);
    await user.click(yesButtons[1]);

    await waitFor(() => screen.getByLabelText("2 / 2 motions answered"));

    // Submit
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByText("Are you sure? Votes cannot be changed after submission.")).toBeInTheDocument();

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("multi-lot partial submit: lot A disabled after submit, lot B stays selectable", async () => {
    // Seed two lots in sessionStorage
    sessionStorage.setItem(
      `meeting_lots_info_${AGM_ID}`,
      JSON.stringify([
        { lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false },
        { lot_owner_id: "lo2", lot_number: "2", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderApp(`/vote/${AGM_ID}/voting`);

    // Wait for sidebar (multi-lot)
    await waitFor(() => screen.getByRole("heading", { name: "Your Lots" }));

    // Deselect lo2 so that handleSubmitClick writes only ["lo1"] to meeting_lots sessionStorage
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]); // uncheck lo2

    // Submit ballot for lo1 only
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    await waitFor(() => screen.getByRole("dialog"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit ballot" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });

    // Lot A (lo1) is now disabled with "Already submitted" badge — use aria-label to target specifically
    const lo1Checkboxes = screen.getAllByLabelText("Select Lot 1");
    const lo2Checkboxes = screen.getAllByLabelText("Select Lot 2");
    lo1Checkboxes.forEach((cb) => expect(cb).toBeDisabled());
    lo2Checkboxes.forEach((cb) => expect(cb).not.toBeDisabled());

    // At least one "Already submitted" badge visible (one per panel for lo1)
    const submittedBadges = screen.getAllByText("Already submitted");
    expect(submittedBadges.length).toBeGreaterThanOrEqual(1);

    sessionStorage.removeItem(`meeting_lots_info_${AGM_ID}`);
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
  });

  // --- Revote integration scenario (BUG-RV-01) ---

  it("revote: submit button visible after prior submission when new visible motion exists", async () => {
    // Simulate a voter returning after admin made a new motion visible.
    // Backend now returns already_submitted=false (motion-aware).
    // The voting page must show the submit button.
    const { http, HttpResponse } = await import("msw");
    const { server } = await import("../../../../tests/msw/server");
    const { MOTION_ID_1, MOTION_ID_2, AGM_ID: AGM } = await import("../../../../tests/msw/handlers");

    server.use(
      http.get(`http://localhost:8000/api/general-meeting/${AGM}/motions`, () =>
        HttpResponse.json([
          // Motion 1 was voted on previously (already_voted=true)
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true },
          // Motion 2 is newly visible — not yet voted
          { id: MOTION_ID_2, title: "New Motion", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: false },
        ])
      )
    );

    // Backend returns already_submitted=false (new correct logic: M2 not yet voted)
    sessionStorage.setItem(
      `meeting_lots_info_${AGM}`,
      JSON.stringify([
        { lot_owner_id: "lo-e2e", lot_number: "E2E-1", financial_position: "normal", already_submitted: false, is_proxy: false },
      ])
    );

    renderApp(`/vote/${AGM}/voting`);

    // Motion 2 should be interactive (not read-only)
    await waitFor(() => screen.getByRole("heading", { name: "New Motion" }));

    // Submit ballot button must be present (unvotedMotions=[Motion 2])
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
    });

    sessionStorage.removeItem(`meeting_lots_info_${AGM}`);
  });

  it("revote: submit button hidden after voter has voted on all currently visible motions", async () => {
    // After revote: all motions are already_voted=true → unvotedMotions=[] → no submit button.
    const { http, HttpResponse } = await import("msw");
    const { server } = await import("../../../../tests/msw/server");
    const { MOTION_ID_1, MOTION_ID_2, AGM_ID: AGM } = await import("../../../../tests/msw/handlers");

    server.use(
      http.get(`http://localhost:8000/api/general-meeting/${AGM}/motions`, () =>
        HttpResponse.json([
          { id: MOTION_ID_1, title: "Motion 1", description: null, display_order: 1, motion_type: "general", is_visible: true, already_voted: true },
          { id: MOTION_ID_2, title: "Motion 2", description: null, display_order: 2, motion_type: "special", is_visible: true, already_voted: true },
        ])
      )
    );

    // Backend returns already_submitted=true and all visible motions in voted_motion_ids
    sessionStorage.setItem(
      `meeting_lots_info_${AGM}`,
      JSON.stringify([
        { lot_owner_id: "lo-e2e", lot_number: "E2E-1", financial_position: "normal", already_submitted: true, is_proxy: false, voted_motion_ids: [MOTION_ID_1, MOTION_ID_2] },
      ])
    );

    renderApp(`/vote/${AGM}/voting`);

    await waitFor(() => screen.getByRole("heading", { name: "Motion 1" }));

    // No submit button — all motions read-only (already_voted=true, no unsubmitted lots)
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Submit ballot" })).not.toBeInTheDocument();
    });

    sessionStorage.removeItem(`meeting_lots_info_${AGM}`);

  });
});
