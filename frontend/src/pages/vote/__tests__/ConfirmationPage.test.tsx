import React from "react";
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

function renderPage(agmId = AGM_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/vote/${agmId}/confirmation`]}>
        <Routes>
          <Route path="/vote/:agmId/confirmation" element={<ConfirmationPage />} />
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

  it("renders building name and AGM title", async () => {
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
      expect(screen.getByText("Yes")).toBeInTheDocument();
      expect(screen.getByText(/Motion 2/)).toBeInTheDocument();
      expect(screen.getByText("No")).toBeInTheDocument();
    });
  });

  it("shows 'You did not submit' on 404", async () => {
    server.use(
      http.get(`${BASE}/api/agm/${AGM_ID}/my-ballot`, () =>
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
      http.get(`${BASE}/api/agm/${AGM_ID}/my-ballot`, () =>
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
      http.get(`${BASE}/api/agm/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          agm_title: "Test AGM",
          building_name: "Test Building",
          votes: [
            { motion_id: "m2", motion_title: "Second Motion", order_index: 1, choice: "no" },
            { motion_id: "m1", motion_title: "First Motion", order_index: 0, choice: "yes" },
          ],
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
      http.get(`${BASE}/api/agm/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          agm_title: "Test AGM",
          building_name: "Test Building",
          votes: [
            { motion_id: "m1", motion_title: "Motion", order_index: 0, choice: "abstained" },
          ],
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
      expect(screen.getByRole("button", { name: "Back to Home" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Back to Home" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("falls back to raw choice value for unknown choice key", async () => {
    server.use(
      http.get(`${BASE}/api/agm/${AGM_ID}/my-ballot`, () =>
        HttpResponse.json({
          voter_email: "voter@test.com",
          agm_title: "Test AGM",
          building_name: "Test Building",
          votes: [
            { motion_id: "m1", motion_title: "Motion", order_index: 0, choice: "unknown_choice" },
          ],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("unknown_choice")).toBeInTheDocument();
    });
  });
});
