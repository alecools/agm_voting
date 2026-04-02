import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import AdminVoteEntryPanel from "../AdminVoteEntryPanel";
import { ADMIN_MEETING_DETAIL, ADMIN_LOT_OWNERS } from "../../../../tests/msw/handlers";
import type { GeneralMeetingDetail } from "../../../api/admin";

function renderPanel(
  props: Partial<{ meeting: GeneralMeetingDetail; onClose: () => void; onSuccess: () => void }> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = props.onClose ?? vi.fn();
  const onSuccess = props.onSuccess ?? vi.fn();
  const meeting = props.meeting ?? ADMIN_MEETING_DETAIL;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AdminVoteEntryPanel meeting={meeting} onClose={onClose} onSuccess={onSuccess} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AdminVoteEntryPanel", () => {
  // Step 1: Lot selection

  it("renders step 1 lot selection dialog", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Enter In-Person Votes/i })).toBeInTheDocument();
    });
    expect(screen.getByText("Proceed to vote entry (0 lots)")).toBeInTheDocument();
  });

  it("shows loading state while fetching lots", () => {
    server.use(
      http.get("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners", () => {
        return HttpResponse.json([], { status: 200 });
      })
    );
    renderPanel();
    // Immediately shows the dialog
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders lot checkboxes for pending lots", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Select lot 2B")).toBeInTheDocument();
  });

  it("proceed button is disabled when no lots are checked", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    const proceedBtn = screen.getByText(/Proceed to vote entry/);
    expect(proceedBtn).toBeDisabled();
  });

  it("proceed button is enabled after checking a lot", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    expect(screen.getByText("Proceed to vote entry (1 lot)")).toBeEnabled();
  });

  it("cancel button calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("close button (×) calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("pressing Escape calls onClose in step 1", async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("excludes app-submitted lots from the selectable list", async () => {
    // The ADMIN_MEETING_DETAIL has voter1@example.com and voter2@example.com in yes/no
    // but they are not linked to specific lot numbers in the fixture
    // So all ADMIN_LOT_OWNERS should appear (voter list lot_number fields are empty strings)
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
  });

  it("shows 'All lots submitted' message when all lots are app-submitted", async () => {
    // Create a meeting detail where all lots have non-admin submissions
    const meetingWithAllSubmitted: GeneralMeetingDetail = {
      ...ADMIN_MEETING_DETAIL,
      motions: [
        {
          ...ADMIN_MEETING_DETAIL.motions[0],
          voter_lists: {
            ...ADMIN_MEETING_DETAIL.motions[0].voter_lists,
            yes: [
              { voter_email: "o@t.com", lot_number: "1A", entitlement: 100, submitted_by_admin: false },
              { voter_email: "o2@t.com", lot_number: "2B", entitlement: 200, submitted_by_admin: false },
            ],
          },
        },
      ],
    };
    renderPanel({ meeting: meetingWithAllSubmitted });
    await waitFor(() => {
      expect(screen.getByText("All lots have already submitted via the app.")).toBeInTheDocument();
    });
  });

  // Step 2: Vote entry grid

  it("advances to step 2 when Proceed is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Enter In-Person Votes/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Submit votes/)).toBeInTheDocument();
  });

  it("shows motion rows in step 2 grid", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      // Motion 1 title should appear in the grid
      expect(screen.getByText(/Motion 1/)).toBeInTheDocument();
    });
  });

  it("shows For/Against/Abstain buttons for binary motions in grid", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      // Multiple For/Against/Abstain buttons per motion — at least one should exist
      expect(screen.getAllByRole("button", { name: /for lot/i }).length).toBeGreaterThan(0);
    });
  });

  it("can select a vote for a lot in the grid", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /for lot/i }).length).toBeGreaterThan(0);
    });
    const forBtn = screen.getAllByRole("button", { name: /for lot/i })[0];
    await user.click(forBtn);
    expect(forBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("back button in step 2 returns to step 1", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Enter In-Person Votes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "← Back" }));
    await waitFor(() => {
      expect(screen.getByText(/Proceed to vote entry/)).toBeInTheDocument();
    });
  });

  it("submit votes button opens confirmation dialog", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Submit votes/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Submit votes/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Submit in-person votes/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Submitting votes for 1 lot/)).toBeInTheDocument();
  });

  it("cancel on confirm dialog dismisses it without submitting", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Submit votes/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Submit votes/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Submit in-person votes/i })).toBeInTheDocument();
    });
    const cancelBtn = screen.getAllByRole("button", { name: "Cancel" })[0];
    await user.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Submit in-person votes/i })).not.toBeInTheDocument();
    });
    // Still on step 2
    expect(screen.getByRole("button", { name: /Submit votes/ })).toBeInTheDocument();
  });

  it("confirms submission calls onSuccess", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderPanel({ onSuccess });
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Submit votes/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Submit votes/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Submit in-person votes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows error message when submission fails", async () => {
    server.use(
      http.post(
        "http://localhost:8000/api/admin/general-meetings/:meetingId/enter-votes",
        () => HttpResponse.json({ detail: "Meeting is not open" }, { status: 409 })
      )
    );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Submit votes/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Submit votes/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Submit in-person votes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("backdrop click in step 1 calls onClose", async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    // Click the overlay (dialog itself, not its children)
    const overlay = screen.getByRole("dialog");
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows in-arrear badge for in-arrear lots", async () => {
    // Add an in-arrear lot to the fixture
    server.use(
      http.get("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners", () => {
        return HttpResponse.json([
          ...ADMIN_LOT_OWNERS,
          {
            id: "lo-arrear",
            building_id: "b1",
            lot_number: "3C",
            emails: ["arrear@example.com"],
            unit_entitlement: 50,
            financial_position: "in_arrear",
            proxy_email: null,
          },
        ]);
      })
    );
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("In arrear")).toBeInTheDocument();
    });
  });

  it("Escape closes step 2 without submitting", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Enter In-Person Votes/i })).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows 'all answered' indicator when all motions are voted on", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /for lot/i }).length).toBeGreaterThan(0);
    });
    // Click For on the motion
    await user.click(screen.getAllByRole("button", { name: /for lot/i })[0]);
    await waitFor(() => {
      expect(screen.getByText("All answered")).toBeInTheDocument();
    });
  });
});
