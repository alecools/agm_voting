import React from "react";
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

  it("shows error message when close fails", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/close", () => {
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
});
