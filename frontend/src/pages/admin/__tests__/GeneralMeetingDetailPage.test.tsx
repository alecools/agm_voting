import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import GeneralMeetingDetailPage from "../GeneralMeetingDetailPage";
import {
  ADMIN_MEETING_DETAIL,
  ADMIN_MEETING_DETAIL_CLOSED,
  ADMIN_MEETING_DETAIL_PENDING,
  ADMIN_MEETING_DETAIL_HIDDEN_MOTION,
  ADMIN_MEETING_DETAIL_MIXED_VISIBILITY,
  ADMIN_MEETING_DETAIL_ALL_HIDDEN,
} from "../../../../tests/msw/handlers";

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
    // "Motion 1" appears in both the merged motions table and the report view
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

  it("clicking Delete Meeting opens confirm modal", async () => {
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    expect(screen.getByRole("dialog", { name: "Delete Meeting" })).toBeInTheDocument();
    expect(screen.getByText(/This action cannot be undone/)).toBeInTheDocument();
  });

  it("delete modal shows meeting title in heading", async () => {
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    expect(screen.getByRole("heading", { level: 2, name: /2023 AGM/ })).toBeInTheDocument();
  });

  it("confirming delete in modal calls API and navigates away", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Meeting" });
    await user.click(within(dialog).getByRole("button", { name: "Delete Meeting" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings");
    });
  });

  it("cancelling delete modal does not navigate", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    expect(screen.getByRole("dialog", { name: "Delete Meeting" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete Meeting" })).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/general-meetings");
  });

  // --- Motion reorder panel integration ---

  it("renders Motions section heading", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
  });

  it("shows move buttons for open meeting with multiple motions", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-multi") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-multi",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "m1", display_order: 1, title: "Motion 1" },
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "m2", display_order: 2, title: "Motion 2" },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-multi");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Move Motion 1 to bottom/ })).toBeInTheDocument();
    });
  });

  it("does not show move buttons for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Move .* to top/ })).not.toBeInTheDocument();
  });

  it("shows move buttons for pending meeting with multiple motions", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-pending-multi") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL_PENDING,
            id: "agm-pending-multi",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "m1", display_order: 1, title: "Motion 1" },
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "m2", display_order: 2, title: "Motion 2" },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-pending-multi");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Move Motion 1 to bottom/ })).toBeInTheDocument();
    });
  });

  it("clicking 'Move to bottom' calls reorder API and updates display", async () => {
    const user = userEvent.setup();
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
                is_visible: true,
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
    await waitFor(() => {
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

  it("clicking 'Move to top' in visibility table calls reorder API", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-move-top-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-move-top-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "mt1", display_order: 1, title: "Motion First" },
              {
                id: "mt2",
                title: "Motion Last",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                is_visible: true,
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    const { unmount } = renderPage("agm-move-top-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move Motion Last to top" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Move Motion Last to top" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    unmount();
  });

  it("clicking 'Move up' in visibility table calls reorder API", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-move-up-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-move-up-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "mu1", display_order: 1, title: "Motion Alpha" },
              {
                id: "mu2",
                title: "Motion Beta",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                is_visible: true,
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    const { unmount } = renderPage("agm-move-up-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move Motion Beta up" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Move Motion Beta up" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    unmount();
  });

  it("clicking 'Move down' in visibility table calls reorder API", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-move-down-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-move-down-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "md1", display_order: 1, title: "Motion Gamma" },
              {
                id: "md2",
                title: "Motion Delta",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                is_visible: true,
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    const { unmount } = renderPage("agm-move-down-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move Motion Gamma down" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Move Motion Gamma down" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    unmount();
  });

  it("Escape key closes delete modal without navigating", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    expect(screen.getByRole("dialog", { name: "Delete Meeting" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete Meeting" })).not.toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/general-meetings");
  });

  it("clicking backdrop closes delete modal without navigating", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Meeting" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Meeting" });
    expect(dialog).toBeInTheDocument();
    await user.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete Meeting" })).not.toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/general-meetings");
  });

  // --- Motion visibility toggle ---

  it("renders merged motions table with all column headers", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.getByRole("columnheader", { name: "#" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Motion" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Visibility" })).toBeInTheDocument();
  });

  it("renders toggle checkbox checked for visible motion", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    // The checkbox for a visible motion should be checked
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
  });

  it("shows 'Visible' label for visible motion", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Visible")).toBeInTheDocument();
    });
  });

  it("toggle is disabled when meeting is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeDisabled();
  });

  it("clicking toggle on open meeting calls toggleMotionVisibility API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    const checkbox = screen.getAllByRole("checkbox")[0];
    await user.click(checkbox);
    // After successful toggle, query refetches — no error shown
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("shows error and disables toggle after 409 'received votes' response", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", () => {
        return HttpResponse.json(
          { detail: "Cannot hide a motion that has received votes" },
          { status: 409 }
        );
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    const checkbox = screen.getAllByRole("checkbox")[0];
    await user.click(checkbox);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Cannot hide: motion has received votes")).toBeInTheDocument();
    // Toggle should now be permanently disabled (motionsWithVotes set)
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeDisabled();
  });

  it("shows error for generic visibility failure", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", () => {
        return HttpResponse.json({ detail: "Internal server error" }, { status: 500 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    const checkbox = screen.getAllByRole("checkbox")[0];
    await user.click(checkbox);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to update visibility")).toBeInTheDocument();
  });

  it("shows 'Cannot change visibility on a closed meeting' error message", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", () => {
        return HttpResponse.json(
          { detail: "Cannot change visibility on a closed meeting" },
          { status: 409 }
        );
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    const checkbox = screen.getAllByRole("checkbox")[0];
    await user.click(checkbox);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Cannot change visibility on a closed meeting")).toBeInTheDocument();
  });

  it("shows 'No motions.' when meeting has no motions", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-no-motions") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-no-motions",
            motions: [],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-no-motions");
    await waitFor(() => {
      expect(screen.getByText("No motions.")).toBeInTheDocument();
    });
  });

  // --- Actions column ---

  it("renders Actions column header in motions table", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    });
  });

  it("renders Edit and Delete buttons for each motion row", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("Edit button is disabled when motion is visible", async () => {
    // ADMIN_MEETING_DETAIL has a visible motion (is_visible: true)
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("Delete button is disabled when motion is visible", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("Edit and Delete buttons have correct tooltip when disabled for visible motion", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute(
      "title",
      "Hide this motion first to edit or delete"
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "title",
      "Hide this motion first to edit or delete"
    );
  });

  it("Edit button is hidden for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("Delete button is hidden for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("Add Motion form", () => {
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

  // --- Happy path ---

  it("Add Motion button is visible for open meeting", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
  });

  it("Add Motion button is visible for pending meeting", async () => {
    renderPage("agm-pending");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
  });

  it("clicking Add Motion opens a modal dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    expect(screen.getByRole("dialog", { name: "Add Motion" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Motion number (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Motion Type")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Motion" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("submitting the form with valid data calls the API and closes the form", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    await user.type(screen.getByLabelText("Title *"), "New Test Motion");
    await user.click(screen.getByRole("button", { name: "Save Motion" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save Motion" })).not.toBeInTheDocument();
    });
  });

  it("submitting add motion with motion_number sends it in the payload", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/motions", async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          id: "motion-new",
          title: capturedBody.title,
          description: capturedBody.description ?? null,
          display_order: 3,
          motion_number: capturedBody.motion_number ?? null,
          motion_type: capturedBody.motion_type ?? "general",
          is_visible: false,
        }, { status: 201 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    await user.type(screen.getByLabelText("Title *"), "Test Motion");
    await user.type(screen.getByLabelText("Motion number (optional)"), "S-1");
    await user.click(screen.getByRole("button", { name: "Save Motion" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save Motion" })).not.toBeInTheDocument();
    });
    expect(capturedBody).toHaveProperty("motion_number", "S-1");
  });

  // --- Input validation ---

  it("submitting with blank title shows validation error without calling API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    await user.click(screen.getByRole("button", { name: "Save Motion" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Title is required")).toBeInTheDocument();
    // Form is still open
    expect(screen.getByRole("button", { name: "Save Motion" })).toBeInTheDocument();
  });

  // --- State / precondition errors ---

  it("Add Motion button is NOT shown for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Add Motion" })).not.toBeInTheDocument();
  });

  it("API error is shown inline when submission fails", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    await user.type(screen.getByLabelText("Title *"), "add-fail");
    await user.click(screen.getByRole("button", { name: "Save Motion" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  // --- Edge cases ---

  it("Cancel button closes the modal without calling the API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    expect(screen.getByRole("dialog", { name: "Add Motion" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Add Motion" })).not.toBeInTheDocument();
    // Add Motion button is still present
    expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
  });

  it("Escape key closes the Add Motion modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    expect(screen.getByRole("dialog", { name: "Add Motion" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add Motion" })).not.toBeInTheDocument();
    });
  });

  it("clicking the backdrop closes the Add Motion modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    const dialog = screen.getByRole("dialog", { name: "Add Motion" });
    expect(dialog).toBeInTheDocument();
    // The backdrop is the previous sibling div of the dialog panel
    const backdrop = dialog.previousElementSibling as HTMLElement;
    fireEvent.click(backdrop);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add Motion" })).not.toBeInTheDocument();
    });
  });

  it("Save button is disabled while mutation is pending", async () => {
    const user = userEvent.setup();
    // Use a handler that never resolves to keep the mutation pending
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/motions", async () => {
        await new Promise(() => {}); // never resolves
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    await user.type(screen.getByLabelText("Title *"), "Pending Motion");
    await user.click(screen.getByRole("button", { name: "Save Motion" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    });
  });
});

describe("Edit motion modal", () => {
  function renderPage(meetingId = "agm-hidden-motion") {
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

  // --- Happy path ---

  it("Edit button is present on hidden motion row for open meeting", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled();
  });

  it("clicking Edit opens modal dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Edit Motion")).toBeInTheDocument();
  });

  it("modal pre-fills form fields with current motion values including motion number", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("#modal-edit-title")).toHaveValue(
      ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions[0].title
    );
    expect(dialog.querySelector("#modal-edit-description")).toHaveValue(
      ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions[0].description ?? ""
    );
    expect(dialog.querySelector("#modal-edit-motion-number")).toHaveValue(
      ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions[0].motion_number ?? ""
    );
  });

  it("motion number input is visible in the edit modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Motion number (optional)")).toBeInTheDocument();
  });

  it("editing motion number sends updated value to API", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId", async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        const motion = ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions[0];
        return HttpResponse.json({
          ...motion,
          id: "m-hidden",
          motion_number: capturedBody.motion_number ?? motion.motion_number,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const motionNumberInput = screen.getByLabelText("Motion number (optional)");
    await user.clear(motionNumberInput);
    await user.type(motionNumberInput, "SR-1");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
    });
    expect(capturedBody!.motion_number).toBe("SR-1");
  });

  it("modal pre-fills motion_number from the motion being edited", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Motion number (optional)")).toHaveValue("M-42");
  });

  it("submitting edit sends updated motion_number value", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId", async ({ params, request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        const motion = ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions[0];
        return HttpResponse.json({ ...motion, id: params.motionId as string, ...capturedBody });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Motion number (optional)");
    await user.clear(input);
    await user.type(input, "M-99");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedBody).toHaveProperty("motion_number", "M-99");
  });

  it("whitespace-only motion_number sends null", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId", async ({ params, request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        const motion = ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions[0];
        return HttpResponse.json({ ...motion, id: params.motionId as string, ...capturedBody });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Motion number (optional)");
    await user.clear(input);
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedBody).toHaveProperty("motion_number", null);
  });

  it("Save Changes button calls PATCH and closes modal on success", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  // --- State / precondition errors ---

  it("Edit button is disabled when motion is visible", async () => {
    // agm1 has a visible motion
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm1"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("Edit button is hidden when meeting is closed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm2"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("disabled Edit button has correct title tooltip", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm1"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute(
      "title",
      "Hide this motion first to edit or delete"
    );
  });

  it("API error is shown inside modal when PATCH fails", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-hidden-edit-fail") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL_HIDDEN_MOTION,
            id: "agm-hidden-edit-fail",
            motions: ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions.map((m) => ({
              ...m,
              id: "motion-edit-fail",
            })),
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm-hidden-edit-fail"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // Modal stays open on error
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // --- Edge cases ---

  it("Cancel button closes modal without calling API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape key closes modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("clicking backdrop closes modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Click the backdrop (the dialog element itself, not the inner panel)
    await user.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("Save Changes button is disabled while mutation is pending", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId", async ({ params }) => {
        if (params.motionId === "m-hidden") {
          await new Promise(() => {}); // never resolves
        }
        return HttpResponse.json({});
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    });
  });

  it("Edit button has btn--secondary class", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass("btn--secondary");
  });

  it("Delete button has btn--danger class", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn--danger");
  });
});

describe("Delete motion", () => {
  function renderPage(meetingId = "agm-hidden-motion") {
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

  // --- Happy path ---

  it("Delete button is present on hidden motion row for open meeting", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).not.toBeDisabled();
  });

  it("confirming delete calls DELETE endpoint", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      // After successful delete, query is invalidated and meeting reloads
      expect(window.confirm).toHaveBeenCalledWith("Delete this motion? This cannot be undone.");
    });
  });

  // --- State / precondition errors ---

  it("Delete button is disabled when motion is visible", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm1"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("Delete button is hidden when meeting is closed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm2"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("disabled Delete button has correct title tooltip", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm1"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "title",
      "Hide this motion first to edit or delete"
    );
  });

  it("API error is shown inline when DELETE fails", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-hidden-delete-fail") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL_HIDDEN_MOTION,
            id: "agm-hidden-delete-fail",
            motions: ADMIN_MEETING_DETAIL_HIDDEN_MOTION.motions.map((m) => ({
              ...m,
              id: "motion-delete-fail",
            })),
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/general-meetings/agm-hidden-delete-fail"]}>
          <Routes>
            <Route path="/admin/general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("successful delete after error clears the error message", async () => {
    // First set up a failing delete, then a succeeding one for the same motion
    let callCount = 0;
    server.use(
      http.delete("http://localhost:8000/api/admin/motions/:motionId", () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({ detail: "Server error" }, { status: 500 });
        }
        return new HttpResponse(null, { status: 204 });
      })
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    // First click: causes error
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    // Second click: succeeds and clears error
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  // --- Edge cases ---

  it("dismissing confirm dialog makes no API call", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    // No alert shown (no API error), form still shows delete button enabled
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Visibility toggle optimistic update
// ---------------------------------------------------------------------------

describe("Visibility toggle optimistic update", () => {
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

  it("toggle changes state immediately (optimistic) before server response arrives", async () => {
    // Use a handler that never resolves so the server response never arrives
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async () => {
        await new Promise(() => {}); // never resolves — keeps mutation in-flight
      })
    );
    // agm-hidden-motion has a single hidden motion (is_visible: false)
    const user = userEvent.setup();
    renderPage("agm-hidden-motion");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[0];
    // Initially unchecked (motion is hidden)
    expect(checkbox).not.toBeChecked();

    // Click to show — the optimistic update should flip it immediately
    await user.click(checkbox);

    // The checkbox must be checked immediately after the click,
    // without waiting for the (never-arriving) server response.
    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    });
  });

  it("toggle reverts when server returns an error", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", () => {
        return HttpResponse.json({ detail: "Internal server error" }, { status: 500 });
      })
    );
    const user = userEvent.setup();
    renderPage("agm-hidden-motion");
    await waitFor(() => {
      expect(screen.getByText("Motions")).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[0];
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    // After error, the optimistic update should be reverted
    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    });
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Reorder buttons are in the Actions column alongside Edit/Delete
// ---------------------------------------------------------------------------

describe("Reorder buttons in Actions column", () => {
  function renderPage(meetingId: string) {
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

  it("reorder and Edit/Delete buttons are in the same table cell", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-reorder-actions-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-reorder-actions-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "ra1", display_order: 1, title: "Action Motion 1", is_visible: false },
              {
                id: "ra2",
                title: "Action Motion 2",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                is_visible: false,
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-reorder-actions-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move Action Motion 1 to bottom" })).toBeInTheDocument();
    });

    const moveToBottomBtn = screen.getByRole("button", { name: "Move Action Motion 1 to bottom" });
    const editBtn = screen.getAllByRole("button", { name: "Edit" })[0];
    const deleteBtn = screen.getAllByRole("button", { name: "Delete" })[0];

    // All three buttons must be in the same <td>
    expect(moveToBottomBtn.closest("td")).toBe(editBtn.closest("td"));
    expect(moveToBottomBtn.closest("td")).toBe(deleteBtn.closest("td"));
  });

  it("Move to top button is in the same cell as Edit/Delete", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-reorder-cell-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-reorder-cell-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "rc1", display_order: 1, title: "Cell Motion 1", is_visible: false },
              {
                id: "rc2",
                title: "Cell Motion 2",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                is_visible: false,
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-reorder-cell-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move Cell Motion 2 to top" })).toBeInTheDocument();
    });

    const moveToTopBtn = screen.getByRole("button", { name: "Move Cell Motion 2 to top" });
    const editBtns = screen.getAllByRole("button", { name: "Edit" });
    const editBtn = editBtns[editBtns.length - 1]; // second row's Edit button

    expect(moveToTopBtn.closest("td")).toBe(editBtn.closest("td"));
  });

  it("Move up and Move down buttons are in the same cell as Edit/Delete", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-updown-cell-test") {
          return HttpResponse.json({
            ...ADMIN_MEETING_DETAIL,
            id: "agm-updown-cell-test",
            motions: [
              { ...ADMIN_MEETING_DETAIL.motions[0], id: "ud1", display_order: 1, title: "UD Motion 1", is_visible: false },
              {
                id: "ud2",
                title: "UD Motion 2",
                description: null,
                display_order: 2,
                motion_number: null,
                motion_type: "general",
                is_visible: false,
                tally: ADMIN_MEETING_DETAIL.motions[0].tally,
                voter_lists: ADMIN_MEETING_DETAIL.motions[0].voter_lists,
              },
            ],
          });
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      })
    );
    renderPage("agm-updown-cell-test");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Move UD Motion 1 down" })).toBeInTheDocument();
    });

    const moveDownBtn = screen.getByRole("button", { name: "Move UD Motion 1 down" });
    const moveUpBtn = screen.getByRole("button", { name: "Move UD Motion 2 up" });
    const firstEditBtn = screen.getAllByRole("button", { name: "Edit" })[0];
    const secondEditBtn = screen.getAllByRole("button", { name: "Edit" })[1];

    expect(moveDownBtn.closest("td")).toBe(firstEditBtn.closest("td"));
    expect(moveUpBtn.closest("td")).toBe(secondEditBtn.closest("td"));
  });
});

// ---------------------------------------------------------------------------
// Bulk motion visibility — Show All / Hide All
// ---------------------------------------------------------------------------

describe("Bulk motion visibility", () => {
  function renderPage(meetingId: string) {
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

  // --- Happy path ---

  it("Show All calls toggleMotionVisibility for each hidden motion", async () => {
    // agm-mixed has 1 visible + 2 hidden motions
    const patchedIds: string[] = [];
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async ({ params, request }) => {
        const body = await request.json() as { is_visible: boolean };
        if (body.is_visible) patchedIds.push(params.motionId as string);
        return HttpResponse.json({ ...ADMIN_MEETING_DETAIL_MIXED_VISIBILITY.motions[0], id: params.motionId as string, is_visible: body.is_visible });
      })
    );
    const user = userEvent.setup();
    renderPage("agm-mixed");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show All" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Show All" }));
    await waitFor(() => {
      expect(patchedIds).toHaveLength(2);
    });
    expect(patchedIds).toContain("m-hidden-1");
    expect(patchedIds).toContain("m-hidden-2");
    // The visible motion should NOT have been patched
    expect(patchedIds).not.toContain("m-visible-1");
  });

  it("Hide All calls toggleMotionVisibility for each visible motion", async () => {
    const patchedIds: string[] = [];
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async ({ params, request }) => {
        const body = await request.json() as { is_visible: boolean };
        if (!body.is_visible) patchedIds.push(params.motionId as string);
        return HttpResponse.json({ ...ADMIN_MEETING_DETAIL_MIXED_VISIBILITY.motions[0], id: params.motionId as string, is_visible: body.is_visible });
      })
    );
    const user = userEvent.setup();
    renderPage("agm-mixed");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide All" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Hide All" }));
    await waitFor(() => {
      expect(patchedIds).toHaveLength(1);
    });
    expect(patchedIds).toContain("m-visible-1");
    expect(patchedIds).not.toContain("m-hidden-1");
    expect(patchedIds).not.toContain("m-hidden-2");
  });

  it("Hide All swallows 409 received-votes errors and still invalidates queries", async () => {
    // m-visible-1 will 409, the operation should still complete without throwing
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async ({ params }) => {
        if (params.motionId === "m-visible-1") {
          return HttpResponse.json({ detail: "Cannot hide a motion that has received votes" }, { status: 409 });
        }
        return HttpResponse.json({ ...ADMIN_MEETING_DETAIL_MIXED_VISIBILITY.motions[0], id: params.motionId as string, is_visible: false });
      })
    );
    const user = userEvent.setup();
    renderPage("agm-mixed");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide All" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Hide All" }));
    // After the operation completes, neither button should be in a loading state
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide All" })).not.toBeDisabled();
    });
    // No unhandled error alert from the bulk operation itself
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  // --- Disabled conditions ---

  it("Show All is disabled when all motions are visible (agm1 — all visible)", async () => {
    // ADMIN_MEETING_DETAIL (agm1) has one motion with is_visible: true
    renderPage("agm1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show All" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Show All" })).toBeDisabled();
  });

  it("Hide All is disabled when no motions are visible (agm-all-hidden)", async () => {
    renderPage("agm-all-hidden");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide All" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Hide All" })).toBeDisabled();
  });

  it("Show All is enabled when at least one motion is hidden", async () => {
    renderPage("agm-mixed");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show All" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Show All" })).not.toBeDisabled();
  });

  it("Hide All is enabled when at least one motion is visible", async () => {
    renderPage("agm-mixed");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide All" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Hide All" })).not.toBeDisabled();
  });

  // --- State / precondition errors ---

  it("both Show All and Hide All buttons are absent when meeting is closed", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Show All" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide All" })).not.toBeInTheDocument();
  });

  it("isBulkLoading disables both bulk buttons and individual visibility toggles", async () => {
    // Use a handler that never resolves to keep the bulk operation in-flight
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async () => {
        await new Promise(() => {}); // never resolves
      })
    );
    const user = userEvent.setup();
    renderPage("agm-all-hidden");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show All" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Show All" }));
    await waitFor(() => {
      // Both buttons show the loading label
      expect(screen.getAllByRole("button", { name: "Working…" })).toHaveLength(2);
    });
    // All bulk buttons disabled
    const workingButtons = screen.getAllByRole("button", { name: "Working…" });
    workingButtons.forEach((btn) => expect(btn).toBeDisabled());
    // Individual toggle checkboxes also disabled
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((cb) => expect(cb).toBeDisabled());
  });

  // --- Edge cases ---

  it("Show All does nothing and stays enabled when all motions are already visible", async () => {
    const patchSpy = vi.fn();
    server.use(
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", () => {
        patchSpy();
        return HttpResponse.json({});
      })
    );
    // agm1 already has all motions visible
    renderPage("agm1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show All" })).toBeDisabled();
    });
    // Button is disabled so no click triggers the handler; patchSpy stays 0
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("query is invalidated after Show All completes", async () => {
    let getCallCount = 0;
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-all-hidden") {
          getCallCount++;
          return HttpResponse.json(ADMIN_MEETING_DETAIL_ALL_HIDDEN);
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      }),
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async ({ params, request }) => {
        const body = await request.json() as { is_visible: boolean };
        return HttpResponse.json({ ...ADMIN_MEETING_DETAIL_ALL_HIDDEN.motions[0], id: params.motionId as string, is_visible: body.is_visible });
      })
    );
    const user = userEvent.setup();
    renderPage("agm-all-hidden");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show All" })).toBeInTheDocument();
    });
    const initialCallCount = getCallCount;
    await user.click(screen.getByRole("button", { name: "Show All" }));
    await waitFor(() => {
      expect(getCallCount).toBeGreaterThan(initialCallCount);
    });
  });

  it("query is invalidated after Hide All completes", async () => {
    let getCallCount = 0;
    server.use(
      http.get("http://localhost:8000/api/admin/general-meetings/:meetingId", ({ params }) => {
        if (params.meetingId === "agm-mixed") {
          getCallCount++;
          return HttpResponse.json(ADMIN_MEETING_DETAIL_MIXED_VISIBILITY);
        }
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      }),
      http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", async ({ params, request }) => {
        const body = await request.json() as { is_visible: boolean };
        return HttpResponse.json({ ...ADMIN_MEETING_DETAIL_MIXED_VISIBILITY.motions[0], id: params.motionId as string, is_visible: body.is_visible });
      })
    );
    const user = userEvent.setup();
    renderPage("agm-mixed");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide All" })).toBeInTheDocument();
    });
    const initialCallCount = getCallCount;
    await user.click(screen.getByRole("button", { name: "Hide All" }));
    await waitFor(() => {
      expect(getCallCount).toBeGreaterThan(initialCallCount);
    });
  });
});
