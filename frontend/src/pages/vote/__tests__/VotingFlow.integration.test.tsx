import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

describe("Voting Flow Integration", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
      expect(screen.getByLabelText("Lot number")).toBeInTheDocument();
    });
  });

  it("lot-selection page renders after navigating to /vote/:meetingId/lot-selection", async () => {
    renderApp(`/vote/${AGM_ID}/lot-selection`);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Your Lots" })).toBeInTheDocument();
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
});
