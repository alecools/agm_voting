import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import AGMDetailPage from "../AGMDetailPage";
import { ADMIN_AGM_DETAIL_CLOSED } from "../../../../tests/msw/handlers";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

function renderPage(agmId = "agm1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/agms/${agmId}`]}>
        <Routes>
          <Route path="/admin/agms/:agmId" element={<AGMDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AGMDetailPage", () => {
  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading AGM...")).toBeInTheDocument();
  });

  it("renders AGM title and building name", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText(/Alpha Tower/)).toBeInTheDocument();
  });

  it("renders status badge", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Open")).toBeInTheDocument();
    });
  });

  it("renders eligible voters and submitted counts", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("shows Close Voting button when AGM is open", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Voting" })).toBeInTheDocument();
    });
  });

  it("does not show Close Voting button when AGM is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Close Voting" })).not.toBeInTheDocument();
  });

  it("shows closed_at date when AGM is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText(/Closed at:/)).toBeInTheDocument();
    });
  });

  it("shows confirmation dialog when Close Voting clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Voting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
  });

  it("closes AGM: confirm button is clickable and calls close API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Voting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    expect(screen.getByRole("button", { name: "Confirm Close" })).toBeInTheDocument();
    // Click confirm - the mutation should fire and onSuccess runs (which re-fetches)
    await user.click(screen.getByRole("button", { name: "Confirm Close" }));
    // Dialog should close after confirmation
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Confirm Close" })).not.toBeInTheDocument();
    });
  });

  it("shows EmailStatusBanner when email delivery failed", async () => {
    renderPage("agm-failed-email");
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/Email delivery failed/)).toBeInTheDocument();
    expect(screen.getByText("SMTP error")).toBeInTheDocument();
  });

  it("shows Retry Send button when email failed", async () => {
    renderPage("agm-failed-email");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry Send" })).toBeInTheDocument();
    });
  });

  it("shows 'AGM not found' for 404", async () => {
    renderPage("agm-notfound");
    await waitFor(() => {
      expect(screen.getByText("AGM not found")).toBeInTheDocument();
    });
  });

  it("renders AGM report view with motions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Results Report")).toBeInTheDocument();
    });
    expect(screen.getByText(/Motion 1/)).toBeInTheDocument();
  });

  it("shows 'Summary page:' section label on the AGM detail page", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Summary page:/)).toBeInTheDocument();
    });
  });

  it("renders summary URL link with correct href", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /\/agm\/agm1\/summary/ })).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: /\/agm\/agm1\/summary/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("/agm/agm1/summary"));
  });

  it("shows Retry Send success after clicking retry", async () => {
    const user = userEvent.setup();
    renderPage("agm-failed-email");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry Send" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Retry Send" }));
    await waitFor(() => {
      expect(screen.getByText("Report queued for resend.")).toBeInTheDocument();
    });
  });

  it("shows EmailStatusBanner with null lastError", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/agms/:agmId", ({ params }) => {
        if (params.agmId === "agm-email-null-error") {
          return HttpResponse.json({
            ...ADMIN_AGM_DETAIL_CLOSED,
            id: "agm-email-null-error",
            email_delivery: { status: "failed", last_error: null },
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-email-null-error");
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/Email delivery failed/)).toBeInTheDocument();
  });

  it("shows generic error when non-404 fetch fails", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/agms/:agmId", () => {
        return HttpResponse.json({ detail: "Server error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load AGM.")).toBeInTheDocument();
    });
  });
});
