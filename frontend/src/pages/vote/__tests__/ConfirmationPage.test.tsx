import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { ConfirmationPage } from "../ConfirmationPage";
import { AGM_ID } from "../../../../tests/msw/handlers";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";

const BASE = "http://localhost:8000";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderPage(meetingId = AGM_ID, supportEmail = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <BrandingContext.Provider value={{ config: { ...DEFAULT_CONFIG, support_email: supportEmail }, isLoading: false }}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/vote/${meetingId}/confirmation`]}>
          <Routes>
            <Route path="/vote/:meetingId/confirmation" element={<ConfirmationPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </BrandingContext.Provider>
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
      // voter_email and submitter_email may both show owner@example.com — use getAllByText
      const matches = screen.getAllByText(/owner@example.com/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders each motion with vote using display_order when motion_number is null", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion 1. Motion 1")).toBeInTheDocument();
      expect(screen.getByText("For")).toBeInTheDocument();
      expect(screen.getByText("Motion 2. Motion 2")).toBeInTheDocument();
      expect(screen.getByText("Against")).toBeInTheDocument();
    });
  });

  it("renders each motion with vote using motion_number when set", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "owner@example.com",
          meeting_title: "2024 AGM",
          building_name: "Sunset Towers",
          submitted_lots: [
            {
              lot_owner_id: "lo-e2e",
              lot_number: "E2E-1",
              financial_position: "normal",
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: "A1", choice: "yes", eligible: true },
                { motion_id: "m2", motion_title: "Motion 2", display_order: 2, motion_number: "  BBB  ", choice: "no", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion A1. Motion 1")).toBeInTheDocument();
      expect(screen.getByText("Motion BBB. Motion 2")).toBeInTheDocument();
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

  it("votes are sorted by display_order", async () => {
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m2", motion_title: "Second Motion", display_order: 2, motion_number: null, choice: "no", eligible: true },
                { motion_id: "m1", motion_title: "First Motion", display_order: 1, motion_number: null, choice: "yes", eligible: true },
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
      expect(items[0]).toHaveTextContent("Motion 1. First Motion");
      expect(items[1]).toHaveTextContent("Motion 2. Second Motion");
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion", display_order: 0, choice: "abstained", eligible: true },
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion", display_order: 0, choice: "unknown_choice", eligible: true },
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 0, choice: "yes", eligible: true },
              ],
            },
            {
              lot_owner_id: "lo2",
              lot_number: "2B",
              financial_position: "normal",
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 0, choice: "no", eligible: true },
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: null, choice: "yes", eligible: true },
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: null, choice: "yes", eligible: true },
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

  // --- Support email (branding) ---

  it("shows support email link when support_email is set in branding config", async () => {
    renderPage(AGM_ID, "support@corp.com");
    await waitFor(() => expect(screen.getByText(/Ballot submitted/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "support@corp.com" })).toBeInTheDocument();
    expect(screen.getByText(/Need help/)).toBeInTheDocument();
  });

  it("does not show support email block when support_email is empty", async () => {
    renderPage(AGM_ID, "");
    await waitFor(() => expect(screen.getByText(/Ballot submitted/)).toBeInTheDocument());
    expect(screen.queryByText(/Need help/)).not.toBeInTheDocument();
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "General Motion", display_order: 0, choice: "not_eligible", eligible: false },
                { motion_id: "m2", motion_title: "Special Motion", display_order: 1, choice: "yes", eligible: true },
              ],
            },
            {
              lot_owner_id: "lo2",
              lot_number: "2B",
              financial_position: "normal",
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "General Motion", display_order: 0, choice: "yes", eligible: true },
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

  it("renders multi-lot ballot motion labels using motion_number when set", async () => {
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Budget Motion", display_order: 1, motion_number: "A1", choice: "yes", eligible: true },
              ],
            },
            {
              lot_owner_id: "lo2",
              lot_number: "2B",
              financial_position: "normal",
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Budget Motion", display_order: 1, motion_number: "A1", choice: "no", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText("Motion A1. Budget Motion")).toHaveLength(2);
    });
  });

  // --- Multi-choice confirmation ---

  it("shows selected option texts for multi_choice vote with options", async () => {
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                {
                  motion_id: "m1",
                  motion_title: "Board Election",
                  display_order: 1,
                  motion_number: null,
                  choice: "selected",
                  eligible: true,
                  is_multi_choice: true,
                  selected_options: [{ text: "Alice" }, { text: "Carol" }],
                },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alice, Carol")).toBeInTheDocument();
    });
  });

  it("shows 'Abstained' for multi_choice vote with no selected options", async () => {
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                {
                  motion_id: "m1",
                  motion_title: "Board Election",
                  display_order: 1,
                  motion_number: null,
                  choice: "abstained",
                  eligible: true,
                  is_multi_choice: true,
                  selected_options: [],
                },
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

  it("shows 'Not eligible' for multi_choice not_eligible vote", async () => {
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                {
                  motion_id: "m1",
                  motion_title: "Board Election",
                  display_order: 1,
                  motion_number: null,
                  choice: "not_eligible",
                  eligible: false,
                  is_multi_choice: true,
                  selected_options: [],
                },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Not eligible")).toBeInTheDocument();
    });
  });

  it("falls back to display_order when motion_number is whitespace in single-lot ballot", async () => {
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
              submitter_email: "voter@test.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion", display_order: 5, motion_number: "   ", choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion 5. Motion")).toBeInTheDocument();
    });
  });

  // --- US-MOV-01: submitter_email / proxy_email display ---

  it("shows 'This ballot was submitted by' with submitter_email in single-lot ballot", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "coowner@example.com",
          meeting_title: "2024 AGM",
          building_name: "Sunset Towers",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              submitter_email: "votera@example.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: null, choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("This ballot was submitted by votera@example.com")).toBeInTheDocument();
    });
  });

  it("shows 'Submitted via proxy by' with proxy_email when proxy_email is set", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "lotowner@example.com",
          meeting_title: "2024 AGM",
          building_name: "Sunset Towers",
          submitted_lots: [
            {
              lot_owner_id: "lo1",
              lot_number: "1A",
              financial_position: "normal",
              submitter_email: "proxy@example.com",
              proxy_email: "proxy@example.com",
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: null, choice: "yes", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Submitted via proxy by proxy@example.com")).toBeInTheDocument();
    });
  });

  it("shows submitter_email in multi-lot ballot for each lot", async () => {
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
              submitter_email: "votera@example.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: null, choice: "yes", eligible: true },
              ],
            },
            {
              lot_owner_id: "lo2",
              lot_number: "2B",
              financial_position: "normal",
              submitter_email: "voterb@example.com",
              proxy_email: null,
              votes: [
                { motion_id: "m1", motion_title: "Motion 1", display_order: 1, motion_number: null, choice: "no", eligible: true },
              ],
            },
          ],
          remaining_lot_owner_ids: [],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("This ballot was submitted by votera@example.com")).toBeInTheDocument();
      expect(screen.getByText("This ballot was submitted by voterb@example.com")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// RR4-37: Single-lot path renders <li> elements inside a <ul>
// ---------------------------------------------------------------------------
describe("ConfirmationPage — RR4-37 valid semantic HTML in single-lot path", () => {
  it("single-lot: vote items are rendered inside a <ul>", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Ballot submitted/i)).toBeInTheDocument();
    });
    // There should be at least one <ul> in the vote summary section
    const voteItems = document.querySelectorAll(".vote-item");
    if (voteItems.length > 0) {
      const parentList = voteItems[0].parentElement;
      expect(parentList?.tagName).toBe("UL");
    }
  });

  it("single-lot: vote items are valid list items (have li element)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Ballot submitted/i)).toBeInTheDocument();
    });
    const voteItems = document.querySelectorAll("li.vote-item");
    expect(voteItems.length).toBeGreaterThan(0);
    // Each li must have a parent ul or ol
    voteItems.forEach((li) => {
      const parent = li.parentElement;
      expect(["UL", "OL"]).toContain(parent?.tagName);
    });
  });
});
