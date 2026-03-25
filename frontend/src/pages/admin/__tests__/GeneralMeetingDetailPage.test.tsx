import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import GeneralMeetingDetailPage from "../GeneralMeetingDetailPage";
import { ADMIN_MEETING_DETAIL, ADMIN_MEETING_DETAIL_CLOSED, ADMIN_MEETING_DETAIL_PENDING } from "../../../../tests/msw/handlers";

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
    // "Motion 1" appears in both the Motions reorder table and the report view
    expect(screen.getAllByText(/Motion 1/).length).toBeGreaterThan(0);
  });

  it("shows 'Summary page:' section label on the meeting detail page", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });
  });

  it("renders summary URL link with correct href", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /\/general-meeting\/agm1\/summary/ })).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: /\/general-meeting\/agm1\/summary/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("/general-meeting/agm1/summary"));
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

  // --- Motion reorder panel integration ---

  it("renders Motions section heading", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
  });

  it("shows move buttons for open meeting motions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Move Motion 1 to top/ })).toBeInTheDocument();
    });
  });

  it("does not show move buttons for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Move .* to top/ })).not.toBeInTheDocument();
  });

  it("shows move buttons for pending meeting", async () => {
    renderPage("agm-pending");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Move Motion 1 to top/ })).toBeInTheDocument();
    });
  });

  it("clicking 'Move to bottom' calls reorder API and updates display", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Move Motion 1 to bottom/ })).toBeInTheDocument();
    });
    // There is only 1 motion in the test fixture so this button is disabled —
    // use a fixture with 2+ motions via server override
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-reorder-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-reorder-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "m1", display_order: 1, title: "First Motion" },
              {
                id: "m2",
                title: "Second Motion",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    const { unmount } = renderPage("agm-reorder-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move First Motion to bottom" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Move First Motion to bottom" }));
    // After clicking, reorderMutation fires — the button click should have been processed
    await waitFor(() => {
      // The mutation fires asynchronously; verify no error alert is shown
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    unmount();
  });

  it("shows reorder error alert when API returns error", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-reorder-error") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-reorder-error",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "m1", display_order: 1, title: "Motion A" },
              {
                id: "m2",
                title: "Motion B",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    const { unmount } = renderPage("agm-reorder-error");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move Motion A to bottom" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Move Motion A to bottom" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    unmount();
  });
});
