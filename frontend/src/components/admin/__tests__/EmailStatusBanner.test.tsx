import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import EmailStatusBanner from "../EmailStatusBanner";

function renderComponent(meetingId = "agm-failed-email", lastError: string | null = "SMTP error", onRetrySuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailStatusBanner meetingId={meetingId} lastError={lastError} onRetrySuccess={onRetrySuccess} />
    </QueryClientProvider>
  );
}

describe("EmailStatusBanner", () => {
  it("renders error banner with message", () => {
    renderComponent();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Email delivery failed/)).toBeInTheDocument();
    expect(screen.getByText("SMTP error")).toBeInTheDocument();
  });

  it("renders without last error when null", () => {
    renderComponent("agm-failed-email", null);
    expect(screen.getByText(/Email delivery failed/)).toBeInTheDocument();
    expect(screen.queryByText("SMTP error")).not.toBeInTheDocument();
  });

  it("renders Retry Send button", () => {
    renderComponent();
    expect(screen.getByRole("button", { name: "Retry Send" })).toBeInTheDocument();
  });

  it("calls onRetrySuccess and shows success message on retry", async () => {
    const user = userEvent.setup();
    const onRetrySuccess = vi.fn();
    renderComponent("agm-failed-email", "error", onRetrySuccess);
    await user.click(screen.getByRole("button", { name: "Retry Send" }));
    await waitFor(() => {
      expect(onRetrySuccess).toHaveBeenCalled();
    });
    expect(screen.getByText(/Report queued for resend\./)).toBeInTheDocument();
  });

  it("shows error message when retry fails", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/general-meetings/:meetingId/resend-report", () => {
        return HttpResponse.json({ detail: "Cannot resend" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderComponent("agm-failed-email", "SMTP error");
    await user.click(screen.getByRole("button", { name: "Retry Send" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });
});
