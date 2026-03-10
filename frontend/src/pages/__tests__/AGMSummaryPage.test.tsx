import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import AGMSummaryPage from "../AGMSummaryPage";
import { SUMMARY_AGM_ID, agmSummaryFixture } from "../../../tests/msw/handlers";

const BASE = "http://localhost:8000";

function renderPage(agmId = SUMMARY_AGM_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/agm/${agmId}/summary`]}>
        <Routes>
          <Route path="/agm/:agmId/summary" element={<AGMSummaryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  document.title = "";
});

describe("AGMSummaryPage", () => {
  // --- Happy path ---

  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders AGM title as h1", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "2024 AGM" })).toBeInTheDocument();
    });
  });

  it("renders building name", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sunset Towers/)).toBeInTheDocument();
    });
  });

  it("renders meeting date", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Meeting:/)).toBeInTheDocument();
    });
  });

  it("renders voting closes date", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Voting closes:/)).toBeInTheDocument();
    });
  });

  it("renders status badge showing Open", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Open")).toBeInTheDocument();
    });
  });

  it("renders status badge showing Closed for closed AGM", async () => {
    server.use(
      http.get(`${BASE}/api/agm/:agmId/summary`, () =>
        HttpResponse.json({ ...agmSummaryFixture, status: "closed" })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Closed")).toBeInTheDocument();
    });
  });

  it("renders motions as numbered list", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/1\. Motion 1/)).toBeInTheDocument();
      expect(screen.getByText(/2\. Motion 2/)).toBeInTheDocument();
    });
  });

  it("renders motion description when present", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Approve the budget")).toBeInTheDocument();
    });
  });

  it("does not render description element when motion has null description", async () => {
    renderPage();
    await waitFor(() => {
      // Motion 2 has null description — only its title should appear, no extra paragraph
      expect(screen.getByText(/2\. Motion 2/)).toBeInTheDocument();
    });
    // The fixture has motion 2 with null description; confirm no blank description paragraph
    const items = screen.getAllByRole("listitem");
    // Motion 2 is the second listitem
    expect(items[1].querySelector("p")).toBeNull();
  });

  it("sets document.title after data loads", async () => {
    renderPage();
    await waitFor(() => {
      expect(document.title).toBe("2024 AGM — AGM Summary");
    });
  });

  // --- Empty motions ---

  it("shows 'No motions listed.' when motions array is empty", async () => {
    server.use(
      http.get(`${BASE}/api/agm/:agmId/summary`, () =>
        HttpResponse.json({ ...agmSummaryFixture, motions: [] })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No motions listed.")).toBeInTheDocument();
    });
  });

  // --- Error states ---

  it("shows 'Meeting not found' for 404 error", async () => {
    server.use(
      http.get(`${BASE}/api/agm/:agmId/summary`, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Meeting not found")).toBeInTheDocument();
    });
  });

  it("shows 'Failed to load meeting.' for network/server error", async () => {
    server.use(
      http.get(`${BASE}/api/agm/:agmId/summary`, () =>
        HttpResponse.json({ detail: "Server error" }, { status: 500 })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load meeting.")).toBeInTheDocument();
    });
  });
});
