import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import CloseGeneralMeetingButton from "../CloseGeneralMeetingButton";

function renderComponent(meetingId = "agm1", meetingTitle = "2024 AGM", onSuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CloseGeneralMeetingButton meetingId={meetingId} meetingTitle={meetingTitle} onSuccess={onSuccess} />
    </QueryClientProvider>
  );
}

describe("CloseGeneralMeetingButton", () => {
  it("renders Close Voting button", () => {
    renderComponent();
    expect(screen.getByRole("button", { name: "Close Voting" })).toBeInTheDocument();
  });

  it("shows confirmation dialog when button clicked", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    expect(screen.getByText(/Close voting for/)).toBeInTheDocument();
    expect(screen.getByText(/2024 AGM/)).toBeInTheDocument();
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
  });

  it("closes dialog on Cancel", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument();
  });

  it("calls onSuccess and closes dialog on Confirm", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent("agm1", "2024 AGM", onSuccess);
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Close" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument();
  });

  // --- US-ACC-02: Focus trap ---

  it("focuses first button inside dialog when it opens", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("wraps Tab focus from last to first button inside dialog", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    const confirmBtn = screen.getByRole("button", { name: "Confirm Close" });
    confirmBtn.focus();
    await user.tab();
    expect(cancelBtn).toHaveFocus();
  });

  it("wraps Shift+Tab from first to last button inside dialog", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    const confirmBtn = screen.getByRole("button", { name: "Confirm Close" });
    cancelBtn.focus();
    await user.tab({ shift: true });
    expect(confirmBtn).toHaveFocus();
  });

  it("shows error message when close fails", async () => {
    server.use(
      http.post("http://localhost/api/admin/general-meetings/:meetingId/close", () => {
        return HttpResponse.json({ detail: "General Meeting is already closed" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderComponent("agm1", "2024 AGM");
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Close" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  it("dialog remains open while mutation is in flight (isPending)", async () => {
    let resolve!: () => void;
    server.use(
      http.post("http://localhost/api/admin/general-meetings/:meetingId/close", () =>
        new Promise<Response>((res) => {
          resolve = () =>
            res(HttpResponse.json({ id: "agm1", status: "closed", closed_at: "2024-06-01T13:00:00Z" }) as Response);
        })
      )
    );
    const user = userEvent.setup();
    renderComponent("agm1", "2024 AGM");
    await user.click(screen.getByRole("button", { name: "Close Voting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Close" }));
    // While in flight: dialog must remain visible and confirm button shows loading label
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Closing..." })).toBeDisabled();
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Resolve the mutation — dialog closes
    resolve();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
