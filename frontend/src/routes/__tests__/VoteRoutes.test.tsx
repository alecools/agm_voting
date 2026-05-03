import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { VoteRoutes } from "../VoteRoutes";
import { AGM_ID } from "../../../tests/msw/handlers";

const BASE = "http://localhost";

function renderRoutes(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <VoteRoutes />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("VoteRoutes", () => {
  beforeEach(() => {
    // Session restore fires on every AuthPage and VotingPage mount via the HttpOnly cookie.
    // Default to 401 so route render tests are not blocked by a restore redirect.
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({ detail: "Session expired or invalid" }, { status: 401 })
      )
    );
  });

  it("renders BuildingSelectPage at /", async () => {
    renderRoutes("/");
    await waitFor(() => {
      expect(screen.getByLabelText("Select your building")).toBeInTheDocument();
    });
  });

  it("renders AuthPage at /vote/:meetingId/auth", async () => {
    renderRoutes(`/vote/${AGM_ID}/auth`);
    await waitFor(() => {
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    });
  });

  it("renders VotingPage at /vote/:meetingId/voting", async () => {
    renderRoutes(`/vote/${AGM_ID}/voting`);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Motion 1" })).toBeInTheDocument();
    });
  });

  it("renders ConfirmationPage at /vote/:meetingId/confirmation", async () => {
    renderRoutes(`/vote/${AGM_ID}/confirmation`);
    await waitFor(() => {
      // voter_email and submitter_email may both show owner@example.com — use getAllByText
      expect(screen.getAllByText(/owner@example.com/).length).toBeGreaterThanOrEqual(1);
    });
  });
});
