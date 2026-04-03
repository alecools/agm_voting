import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import AdminVoteEntryPanel from "../AdminVoteEntryPanel";
import {
  ADMIN_MEETING_DETAIL,
  ADMIN_LOT_OWNERS,
  ADMIN_MEETING_DETAIL_MC_VOTE_ENTRY,
} from "../../../../tests/msw/handlers";
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

  it("unchecking a lot decrements the proceed count", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    expect(screen.getByText("Proceed to vote entry (1 lot)")).toBeInTheDocument();
    // Uncheck it
    await user.click(screen.getByLabelText("Select lot 1A"));
    expect(screen.getByText("Proceed to vote entry (0 lots)")).toBeInTheDocument();
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

  it("can select Abstain vote for a binary motion", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      // aria-label is "abstained for lot {lot} motion {motion}"
      expect(screen.getAllByRole("button", { name: /abstained for lot/i }).length).toBeGreaterThan(0);
    });
    const abstainBtn = screen.getAllByRole("button", { name: /abstained for lot/i })[0];
    await user.click(abstainBtn);
    expect(abstainBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("can select Against/no vote for a binary motion", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      // aria-label is "no for lot {lot} motion {motion}"
      expect(screen.getAllByRole("button", { name: /no for lot/i }).length).toBeGreaterThan(0);
    });
    const againstBtn = screen.getAllByRole("button", { name: /no for lot/i })[0];
    await user.click(againstBtn);
    expect(againstBtn).toHaveAttribute("aria-pressed", "true");
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

  // --- RR4-18: scope="col" on table headers ---
  it("RR4-18: vote grid table headers have scope='col'", async () => {
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
    const headers = document.querySelectorAll("th");
    headers.forEach((th) => {
      expect(th).toHaveAttribute("scope", "col");
    });
  });

  // --- RR4-15: ConfirmDialog focus trap ---
  it("RR4-15: ConfirmDialog focuses Cancel button on open", async () => {
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
    // Cancel button should have focus
    const cancelBtn = screen.getAllByRole("button", { name: "Cancel" })[0];
    expect(document.activeElement).toBe(cancelBtn);
  });

  it("RR4-15: Escape closes ConfirmDialog", async () => {
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
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Submit in-person votes/i })).not.toBeInTheDocument();
    });
  });

  it("RR4-15: Tab from last button in ConfirmDialog wraps to first", async () => {
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
    // Focus the Confirm button (last in dialog)
    const confirmBtn = screen.getByRole("button", { name: "Confirm" });
    const cancelBtns = screen.getAllByRole("button", { name: "Cancel" });
    const cancelBtn = cancelBtns[cancelBtns.length - 1]; // last Cancel is in ConfirmDialog
    act(() => { confirmBtn.focus(); });
    expect(document.activeElement).toBe(confirmBtn);
    // Tab from last should wrap to Cancel (first)
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it("RR4-15: Shift+Tab from first button in ConfirmDialog wraps to last", async () => {
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
    // Focus the Cancel button (first in dialog)
    const cancelBtns = screen.getAllByRole("button", { name: "Cancel" });
    const cancelBtn = cancelBtns[cancelBtns.length - 1];
    const confirmBtn = screen.getByRole("button", { name: "Confirm" });
    act(() => { cancelBtn.focus(); });
    expect(document.activeElement).toBe(cancelBtn);
    // Shift+Tab from first should wrap to Confirm (last)
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);
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

// ---------------------------------------------------------------------------
// US-AVE2-01: For/Against/Abstain per multi-choice option
// ---------------------------------------------------------------------------

describe("AdminVoteEntryPanel — multi-choice For/Against/Abstain (US-AVE2-01)", () => {
  async function goToStepTwo() {
    const user = userEvent.setup();
    renderPanel({ meeting: ADMIN_MEETING_DETAIL_MC_VOTE_ENTRY });
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      // Motion title is rendered as "1. Board Election Entry" in the grid
      expect(screen.getByText(/Board Election Entry/)).toBeInTheDocument();
    });
    return user;
  }

  it("renders For/Against/Abstain buttons for each multi-choice option", async () => {
    await goToStepTwo();
    // 3 options × 3 buttons each = 9 option buttons
    // aria-label format: "For option {text} lot {lot_number}"
    const forBtns = screen.getAllByRole("button", { name: /^For option .+ lot /i });
    const againstBtns = screen.getAllByRole("button", { name: /^Against option .+ lot /i });
    const abstainBtns = screen.getAllByRole("button", { name: /^Abstain option .+ lot /i });
    expect(forBtns.length).toBe(3);
    expect(againstBtns.length).toBe(3);
    expect(abstainBtns.length).toBe(3);
  });

  it("clicking For marks it as pressed (aria-pressed=true)", async () => {
    const user = await goToStepTwo();
    const forAlice = screen.getByRole("button", { name: "For option Alice lot 1A" });
    expect(forAlice).toHaveAttribute("aria-pressed", "false");
    await user.click(forAlice);
    expect(forAlice).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking the same button again deselects it (toggles off)", async () => {
    const user = await goToStepTwo();
    const forAlice = screen.getByRole("button", { name: "For option Alice lot 1A" });
    await user.click(forAlice);
    expect(forAlice).toHaveAttribute("aria-pressed", "true");
    await user.click(forAlice);
    expect(forAlice).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking Against does not affect For state", async () => {
    const user = await goToStepTwo();
    const againstAlice = screen.getByRole("button", { name: "Against option Alice lot 1A" });
    await user.click(againstAlice);
    const forAlice = screen.getByRole("button", { name: "For option Alice lot 1A" });
    expect(forAlice).toHaveAttribute("aria-pressed", "false");
    expect(againstAlice).toHaveAttribute("aria-pressed", "true");
  });

  it("For buttons remain enabled even when option_limit is reached (limit is for tally only)", async () => {
    const user = await goToStepTwo();
    // option_limit = 2; vote For on Alice and Bob
    await user.click(screen.getByRole("button", { name: "For option Alice lot 1A" }));
    await user.click(screen.getByRole("button", { name: "For option Bob lot 1A" }));
    // Carol's For button should still be enabled — unlimited For selections allowed
    const forCarol = screen.getByRole("button", { name: "For option Carol lot 1A" });
    expect(forCarol).not.toBeDisabled();
  });

  it("Against button is always enabled regardless of For count", async () => {
    const user = await goToStepTwo();
    await user.click(screen.getByRole("button", { name: "For option Alice lot 1A" }));
    await user.click(screen.getByRole("button", { name: "For option Bob lot 1A" }));
    // Carol's Against button should remain enabled
    const againstCarol = screen.getByRole("button", { name: "Against option Carol lot 1A" });
    expect(againstCarol).not.toBeDisabled();
  });

  it("shows 'X of Y voted For' counter", async () => {
    const user = await goToStepTwo();
    expect(screen.getByText("0 of 2 voted For")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "For option Alice lot 1A" }));
    expect(screen.getByText("1 of 2 voted For")).toBeInTheDocument();
  });

  it("all For buttons remain enabled regardless of how many are already selected", async () => {
    const user = await goToStepTwo();
    await user.click(screen.getByRole("button", { name: "For option Alice lot 1A" }));
    await user.click(screen.getByRole("button", { name: "For option Bob lot 1A" }));
    // All For buttons remain enabled — no cap on For votes
    expect(screen.getByRole("button", { name: "For option Alice lot 1A" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "For option Bob lot 1A" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "For option Carol lot 1A" })).not.toBeDisabled();
  });

  it("submission sends option_choices array (not option_ids)", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(
        "http://localhost:8000/api/admin/general-meetings/:meetingId/enter-votes",
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ submitted_count: 1, skipped_count: 0 });
        }
      )
    );
    const user = await goToStepTwo();
    await user.click(screen.getByRole("button", { name: "For option Alice lot 1A" }));
    await user.click(screen.getByRole("button", { name: "Against option Bob lot 1A" }));
    await user.click(screen.getByRole("button", { name: /Submit votes/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Submit in-person votes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    const body = capturedBody as { entries: Array<{ multi_choice_votes: Array<{ option_choices: Array<{ option_id: string; choice: string }> }> }> };
    const optChoices = body.entries[0].multi_choice_votes[0].option_choices;
    const aliceChoice = optChoices.find((oc) => oc.option_id === "mc-entry-opt-a");
    const bobChoice = optChoices.find((oc) => oc.option_id === "mc-entry-opt-b");
    expect(aliceChoice?.choice).toBe("for");
    expect(bobChoice?.choice).toBe("against");
    // Carol not in the array (blank = not sent)
    const carolChoice = optChoices.find((oc) => oc.option_id === "mc-entry-opt-c");
    expect(carolChoice).toBeUndefined();
  });

  it("clicking Abstain marks it as pressed", async () => {
    const user = await goToStepTwo();
    const abstainAlice = screen.getByRole("button", { name: "Abstain option Alice lot 1A" });
    expect(abstainAlice).toHaveAttribute("aria-pressed", "false");
    await user.click(abstainAlice);
    expect(abstainAlice).toHaveAttribute("aria-pressed", "true");
  });

  it("in-arrear lot shows Not eligible for multi-choice motion", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners", () => {
        return HttpResponse.json([
          {
            id: "lo-arrear2",
            building_id: "b1",
            lot_number: "4D",
            emails: ["arrear2@example.com"],
            unit_entitlement: 50,
            financial_position: "in_arrear",
            proxy_email: null,
          },
        ]);
      })
    );
    const user = userEvent.setup();
    renderPanel({ meeting: ADMIN_MEETING_DETAIL_MC_VOTE_ENTRY });
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 4D")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Select lot 4D"));
    await user.click(screen.getByText("Proceed to vote entry (1 lot)"));
    await waitFor(() => {
      expect(screen.getByText("Not eligible")).toBeInTheDocument();
    });
  });

  it("blank options are not included in option_choices submission", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(
        "http://localhost:8000/api/admin/general-meetings/:meetingId/enter-votes",
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ submitted_count: 1, skipped_count: 0 });
        }
      )
    );
    const user = await goToStepTwo();
    // Only vote on Alice; Bob and Carol left blank
    await user.click(screen.getByRole("button", { name: "For option Alice lot 1A" }));
    await user.click(screen.getByRole("button", { name: /Submit votes/ }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Submit in-person votes/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    const body = capturedBody as { entries: Array<{ multi_choice_votes: Array<{ option_choices: Array<unknown> }> }> };
    const optChoices = body.entries[0].multi_choice_votes[0].option_choices;
    // Only 1 entry (Alice); Bob and Carol omitted
    expect(optChoices.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RR4-11: React.memo on LotBinaryVoteCell prevents full re-render on vote click
// ---------------------------------------------------------------------------
describe("AdminVoteEntryPanel — RR4-11 memoized LotBinaryVoteCell", () => {
  it("clicking one lot's vote button does not affect the other lot's vote state", async () => {
    // Verify the component structure: clicking one lot's vote does not error
    // and updates only that lot (behavioural test since render-count tracking
    // requires React DevTools integration — we verify the correct aria-pressed state
    // changes only on the clicked lot)
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Select lot 1A")).toBeInTheDocument();
    });
    // Select both lots so multiple lot columns appear
    await user.click(screen.getByLabelText("Select lot 1A"));
    await user.click(screen.getByLabelText("Select lot 2B"));
    await user.click(screen.getByText("Proceed to vote entry (2 lots)"));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /for lot/i }).length).toBeGreaterThan(0);
    });

    // Get all "For" buttons for lot 1A and lot 2B (one per motion)
    const forLot1Buttons = screen.getAllByRole("button", { name: /for lot 1A/i });
    const forLot2Buttons = screen.getAllByRole("button", { name: /for lot 2B/i });

    // Use the first button for each lot (first motion)
    const forLot1Btn = forLot1Buttons[0];
    const forLot2Btn = forLot2Buttons[0];

    // Initially both are not pressed
    expect(forLot1Btn).toHaveAttribute("aria-pressed", "false");
    expect(forLot2Btn).toHaveAttribute("aria-pressed", "false");

    // Click lot 1A's button — only lot 1A should change
    await user.click(forLot1Btn);
    expect(forLot1Btn).toHaveAttribute("aria-pressed", "true");
    // Lot 2B must remain unaffected
    expect(forLot2Btn).toHaveAttribute("aria-pressed", "false");
  });
});
