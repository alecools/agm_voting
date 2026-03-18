import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import GeneralMeetingDetailPage from "../GeneralMeetingDetailPage";
import { ADMIN_MEETING_DETAIL_CLOSED } from "../../../../tests/msw/handlers";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(meetingId = "agm1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/general-meetings/${meetingId}`]}>
        <Routes>
          <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("GeneralMeetingDetailPage", () => {
  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading General Meeting...")).toBeInTheDocument();
  });

  it("renders meeting title and building name", async () => {
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

  it("shows Close Voting button when meeting is open", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Voting" })).toBeInTheDocument();
    });
  });

  it("does not show Close Voting button when meeting is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Close Voting" })).not.toBeInTheDocument();
  });

  it("shows Start Meeting button when meeting is pending", async () => {
    renderPage("agm-pending");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start Meeting" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Close Voting" })).not.toBeInTheDocument();
  });

  it("does not show Start Meeting button when meeting is open", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Start Meeting" })).not.toBeInTheDocument();
  });

  it("does not show Start Meeting button when meeting is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Start Meeting" })).not.toBeInTheDocument();
  });

  it("shows confirmation dialog when Start Meeting clicked for pending meeting", async () => {
    const user = userEvent.setup();
    renderPage("agm-pending");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    expect(screen.getByText(/Are you sure you want to start this meeting/)).toBeInTheDocument();
  });

  it("shows closed_at date when meeting is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText(/Closed at/)).toBeInTheDocument();
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

  it("closes meeting: confirm button is clickable and calls close API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Voting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    expect(screen.getByRole("button", { name: "Confirm Close" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm Close" }));
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

  it("shows 'General Meeting not found' for 404", async () => {
    renderPage("agm-notfound");
    await waitFor(() => {
      expect(screen.getByText("General Meeting not found")).toBeInTheDocument();
    });
  });

  it("renders meeting report view with motions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Results Report")).toBeInTheDocument();
    });
    // Motion 1 appears in both the Motion Visibility section and the Results Report section
    expect(screen.getAllByText(/Motion 1/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'Voting link' section label on the meeting detail page", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Voting link/)).toBeInTheDocument();
    });
  });

  it("renders voting URL link with correct href", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /\/vote\/agm1\/auth/ })).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: /\/vote\/agm1\/auth/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("/vote/agm1/auth"));
  });

  it("shows Retry Send success after clicking retry", async () => {
    const user = userEvent.setup();
    renderPage("agm-failed-email");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry Send" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Retry Send" }));
    await waitFor(() => {
      expect(screen.getByText(/Report queued for resend\./)).toBeInTheDocument();
    });
  });

  it("shows EmailStatusBanner with null lastError", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-email-null-error") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL_CLOSED,
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
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", () => {
        return HttpResponse.json({ detail: "Server error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load General Meeting.")).toBeInTheDocument();
    });
  });

  it("renders back button", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
  });

  it("clicking back navigates to /admin/general-meetings", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings");
  });

  // --- Delete meeting ---

  it("shows Delete Meeting button when meeting is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
  });

  it("shows Delete Meeting button when meeting is pending", async () => {
    renderPage("agm-pending");
    await waitFor(() => {
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
  });

  it("does not show Delete Meeting button when meeting is open", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Delete Meeting" })).not.toBeInTheDocument();
  });

  it("clicking Delete Meeting calls API and navigates away on confirm", async () => {
    mockNavigate.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings");
    });
  });

  it("does not navigate when confirm is cancelled", async () => {
    mockNavigate.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/general-meetings");
  });
});
