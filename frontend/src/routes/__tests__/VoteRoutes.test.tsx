import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoteRoutes } from "../VoteRoutes";
import { AGM_ID } from "../../../tests/msw/handlers";

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
  it("renders BuildingSelectPage at /", async () => {
    renderRoutes("/");
    await waitFor(() => {
      expect(screen.getByLabelText("Select your building")).toBeInTheDocument();
    });
  });

  it("renders AuthPage at /vote/:agmId/auth", async () => {
    renderRoutes(`/vote/${AGM_ID}/auth`);
    await waitFor(() => {
      expect(screen.getByLabelText("Lot number")).toBeInTheDocument();
    });
  });

  it("renders VotingPage at /vote/:agmId/voting", async () => {
    renderRoutes(`/vote/${AGM_ID}/voting`);
    await waitFor(() => {
      expect(screen.getByText("Motion 1")).toBeInTheDocument();
    });
  });

  it("renders ConfirmationPage at /vote/:agmId/confirmation", async () => {
    renderRoutes(`/vote/${AGM_ID}/confirmation`);
    await waitFor(() => {
      expect(screen.getByText(/owner@example.com/)).toBeInTheDocument();
    });
  });
});
