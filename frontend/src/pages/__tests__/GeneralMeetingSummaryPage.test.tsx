import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import GeneralMeetingSummaryPage from "../GeneralMeetingSummaryPage";
import { SUMMARY_AGM_ID, agmSummaryFixture } from "../../../tests/msw/handlers";

const BASE = "http://localhost:8000";

function renderPage(meetingId = SUMMARY_AGM_ID) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/general-meeting/${meetingId}/summary`]}>
        <Routes>
          <Route path="/general-meeting/:meetingId/summary" element={<GeneralMeetingSummaryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Render with no retry override so the component's own retry function takes effect. */
function renderPageWithComponentRetry(meetingId = SUMMARY_AGM_ID) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/general-meeting/${meetingId}/summary`]}>
        <Routes>
          <Route path="/general-meeting/:meetingId/summary" element={<GeneralMeetingSummaryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  document.title = "";
});

describe("GeneralMeetingSummaryPage", () => {
  // --- Happy path ---

  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders meeting title as h1", async () => {
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

  it("renders status badge showing Closed for closed meeting", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/:meetingId/summary`, () =>
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

  it("displays motion_number as label when set on a motion", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/:meetingId/summary`, () =>
        HttpResponse.json({
          ...agmSummaryFixture,
          motions: [
            { display_order: 1, motion_number: "SR-1", title: "Special Motion", description: null },
            { display_order: 2, motion_number: null, title: "General Motion", description: null },
          ],
        })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/SR-1\. Special Motion/)).toBeInTheDocument();
      expect(screen.getByText(/2\. General Motion/)).toBeInTheDocument();
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
      expect(screen.getByText(/2\. Motion 2/)).toBeInTheDocument();
    });
    const items = screen.getAllByRole("listitem");
    expect(items[1].querySelector("p")).toBeNull();
  });

  it("sets document.title after data loads", async () => {
    renderPage();
    await waitFor(() => {
      expect(document.title).toBe("2024 AGM — General Meeting Summary");
    });
  });

  // --- Empty motions ---

  it("shows 'No motions listed.' when motions array is empty", async () => {
    server.use(
      http.get(`${BASE}/api/general-meeting/:meetingId/summary`, () =>
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
      http.get(`${BASE}/api/general-meeting/:meetingId/summary`, () =>
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
      http.get(`${BASE}/api/general-meeting/:meetingId/summary`, () =>
        HttpResponse.json({ detail: "Server error" }, { status: 500 })
      )
    );
    // Use component retry config (retryDelay:0) so the 3 automatic retries
    // complete instantly and the error state renders within the waitFor window.
    renderPageWithComponentRetry();
    await waitFor(
      () => {
        expect(screen.getByText("Failed to load meeting.")).toBeInTheDocument();
      },
      { timeout: 10000 }
    );
  });

  // --- Retry logic ---

  it("retry function returns false immediately for 404 errors (no retries)", async () => {
    // Use component's own retry config (no override). The 404 branch of the retry
    // callback returns false so the error shows without any retry delay.
    server.use(
      http.get(`${BASE}/api/general-meeting/:meetingId/summary`, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 })
      )
    );
    renderPageWithComponentRetry();
    await waitFor(() => {
      expect(screen.getByText("Meeting not found")).toBeInTheDocument();
    });
  });

});
