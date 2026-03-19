import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import GeneralMeetingDetailPage from "../GeneralMeetingDetailPage";
import {
  ADMIN_MEETING_DETAIL,
  ADMIN_MEETING_DETAIL_CLOSED,
  ADMIN_MEETING_DETAIL_HIDDEN_MOTION,
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

  // --- Motion visibility toggle ---

  it("renders motion visibility section with table headers", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
    });
    expect(screen.getByRole("columnheader", { name: "#" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Motion" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Visibility" })).toBeInTheDocument();
  });

  it("renders toggle checkbox checked for visible motion", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
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
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
    });
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeDisabled();
  });

  it("clicking toggle on open meeting calls toggleMotionVisibility API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
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
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
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
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
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
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
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
      expect(screen.getByText("Motion Visibility")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
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

  it("Edit button is disabled for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("Delete button is disabled for closed meeting", async () => {
    renderPage("agm2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
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

  it("clicking Add Motion shows the inline form", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    expect(screen.getByLabelText("Title *")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
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

  it("Cancel button hides the form without calling the API", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    expect(screen.getByRole("button", { name: "Save Motion" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Save Motion" })).not.toBeInTheDocument();
    // Add Motion button is back
    expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
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

  it("modal pre-fills form fields with current motion values", async () => {
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

  it("Edit button is disabled when meeting is closed", async () => {
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
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
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

  it("Delete button is disabled when meeting is closed", async () => {
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
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
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
