import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import StartGeneralMeetingButton from "../StartGeneralMeetingButton";

function renderComponent(meetingId = "agm-pending", onSuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StartGeneralMeetingButton meetingId={meetingId} onSuccess={onSuccess} />
    </QueryClientProvider>
  );
}

describe("StartGeneralMeetingButton", () => {
  it("renders Start Meeting button", () => {
    renderComponent();
    expect(screen.getByRole("button", { name: "Start Meeting" })).toBeInTheDocument();
  });

  it("shows confirmation dialog when button clicked", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to start this meeting/)).toBeInTheDocument();
  });

  it("closes dialog on Cancel", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls onSuccess and closes dialog on Confirm Start", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent("agm-pending", onSuccess);
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Start" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows loading state while in flight", async () => {
    let resolve!: () => void;
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/start", () =>
        new Promise<Response>((res) => {
          resolve = () =>
            res(HttpResponse.json({ id: "agm-pending", status: "open", meeting_at: "2026-01-01T00:00:00Z" }) as Response);
        })
      )
    );
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Start" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Starting..." })).toBeDisabled();
    });
    resolve();
  });

  it("shows error message when start fails", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/start", () => {
        return HttpResponse.json({ detail: "General Meeting is not in pending status" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderComponent("agm-not-pending");
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Start" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  it("Cancel button clears error state when reopened", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/start", () => {
        return HttpResponse.json({ detail: "Error" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderComponent("agm-not-pending");
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    await user.click(screen.getByRole("button", { name: "Confirm Start" }));
    await waitFor(() => expect(screen.getByText(/409/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Reopen — error should be gone
    await user.click(screen.getByRole("button", { name: "Start Meeting" }));
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
  });
});
