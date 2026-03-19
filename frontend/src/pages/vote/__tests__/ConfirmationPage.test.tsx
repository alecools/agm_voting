import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { ConfirmationPage } from "../ConfirmationPage";
import { AGM_ID } from "../../../../tests/msw/handlers";

const BASE = "http://localhost:8000";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderPage(meetingId = AGM_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/vote/${meetingId}/confirmation`]}>
        <Routes>
          <Route path="/vote/:meetingId/confirmation" element={<ConfirmationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ConfirmationPage", () => {
  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading your submission...")).toBeInTheDocument();
  });

  it("renders building name and meeting title", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sunset Towers/)).toBeInTheDocument();
      expect(screen.getByText(/2024 AGM/)).toBeInTheDocument();
    });
  });

  it("renders voter email", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/owner@example.com/)).toBeInTheDocument();
    });
  });

  it("renders each motion with vote", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Motion 1/)).toBeInTheDocument();
      expect(screen.getByText("For")).toBeInTheDocument();
      expect(screen.getByText(/Motion 2/)).toBeInTheDocument();
      expect(screen.getByText("Against")).toBeInTheDocument();
    });
  });

  it("shows 'You did not submit' on 404", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({ detail: "not found" }, { status: 404 })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText("You did not submit a ballot for this meeting.")
      ).toBeInTheDocument();
    });
  });

  it("shows error message on non-404 failure", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({ detail: "server error" }, { status: 500 })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to load your ballot");
    });
  });

  it("votes are sorted by order_index", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          meeting_title: "Test Meeting",
          building_name: "Test Building",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              votes: [
                { motion_id: "m2", motion_title: "Second Motion", order_index: 1, choice: "no", eligible: true },
                { motion_id: "m1", motion_title: "First Motion", order_index: 0, choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      const items = screen.getAllByRole("listitem");
      expect(items[0]).toHaveTextContent("First Motion");
      expect(items[1]).toHaveTextContent("Second Motion");
    });
  });

  it("shows Abstained for abstained votes", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          meeting_title: "Test Meeting",
          building_name: "Test Building",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "Motion", order_index: 0, choice: "abstained", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Abstained")).toBeInTheDocument();
    });
  });

  it("shows Back to Home button and navigates to / on click", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /back to home/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /back to home/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("falls back to raw choice value for unknown choice key", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          meeting_title: "Test Meeting",
          building_name: "Test Building",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "Motion", order_index: 0, choice: "unknown_choice", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("unknown_choice")).toBeInTheDocument();
    });
  });

  it("renders multi-lot ballot with lot headers", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          meeting_title: "Test Meeting",
          building_name: "Test Building",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", order_index: 0, choice: "yes", eligible: true },
              ],
            },
            {
              lot_owner_id: "lo2",
              lot_number: "2B",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", order_index: 0, choice: "no", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Lot 1A")).toBeInTheDocument();
      expect(screen.getByText("Lot 2B")).toBeInTheDocument();
    });
  });

  it("always shows a back-to-voting button regardless of remaining lots (BUG-RV-02)", async () => {
    // Default fixture has remaining_lot_owner_ids: [] — back button should still show as "View my votes"
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /view my votes/i })).toBeInTheDocument();
    });
  });

  it("back-to-voting button label is 'View my votes' when no remaining lots", async () => {
    // remaining_lot_owner_ids is empty → label is "View my votes"
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /view my votes/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /vote for remaining lots/i })).not.toBeInTheDocument();
    });
  });

  it("clicking 'View my votes' navigates to voting page without writing sessionStorage", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /view my votes/i })).toBeInTheDocument();
    });
    // Remove any prior sessionStorage for this key
    sessionStorage.removeItem(`meeting_lots_${AGM_ID}`);
    await user.click(screen.getByRole("button", { name: /view my votes/i }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
    // sessionStorage NOT written because no remaining lots
    expect(sessionStorage.getItem(`meeting_lots_${AGM_ID}`)).toBeNull();
  });

  it("does not show 'Vote for remaining lots' button when remaining_lot_owner_ids is empty (legacy check)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /vote for remaining lots/i })).not.toBeInTheDocument();
    });
  });

  it("shows 'Vote for remaining lots' button when remaining_lot_owner_ids is non-empty", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "owner@example.com",
          meeting_title: "2024 AGM",
          building_name: "Sunset Towers",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", order_index: 0, choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: ["lo2", "lo3"],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /vote for remaining lots/i })).toBeInTheDocument();
    });
  });

  it("clicking 'Vote for remaining lots' writes remaining IDs to sessionStorage and navigates to voting", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "owner@example.com",
          meeting_title: "2024 AGM",
          building_name: "Sunset Towers",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", order_index: 0, choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: ["lo2", "lo3"],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /vote for remaining lots/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /vote for remaining lots/i }));
    expect(sessionStorage.getItem(`meeting_lots_${AGM_ID}`)).toBe(JSON.stringify(["lo2", "lo3"]));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
  });

  it("shows 'Not eligible' label for not_eligible votes in multi-lot ballot", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          meeting_title: "Test Meeting",
          building_name: "Test Building",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "in_arrear",
              votes: [
                { motion_id: "m1", motion_title: "General Motion", order_index: 0, choice: "not_eligible", eligible: false },
                { motion_id: "m2", motion_title: "Special Motion", order_index: 1, choice: "yes", eligible: true },
              ],
            },
            {
              lot_owner_id: "lo2",
              lot_number: "2B",
              financial_position: "normal",
              votes: [
                { motion_id: "m1", motion_title: "General Motion", order_index: 0, choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Lot 1A")).toBeInTheDocument();
      expect(screen.getByText("Not eligible")).toBeInTheDocument();
    });
  });
});
