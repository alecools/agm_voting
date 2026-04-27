import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import BuildingForm from "../BuildingForm";

function renderComponent(onSuccess = vi.fn(), onCancel = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    onSuccess,
    onCancel,
    ...render(
      <QueryClientProvider client={queryClient}>
        <BuildingForm onSuccess={onSuccess} onCancel={onCancel} />
      </QueryClientProvider>
    ),
  };
}

describe("BuildingForm", () => {
  it("renders the form heading, fields, and buttons", () => {
    renderComponent();
    expect(screen.getByRole("heading", { name: "Create Building" })).toBeInTheDocument();
    expect(screen.getByLabelText("Building Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Manager Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Building" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows error when building name is empty", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    expect(screen.getByText("Building name is required.")).toBeInTheDocument();
  });

  it("shows error when manager email is empty", async () => {
    const user = userEvent.setup();
    renderComponent();
    await user.type(screen.getByLabelText("Building Name"), "Test Tower");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    expect(screen.getByText("Manager email is required.")).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComponent();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onSuccess after successful creation", async () => {
    const user = userEvent.setup();
    const { onSuccess } = renderComponent();
    await user.type(screen.getByLabelText("Building Name"), "New Tower");
    await user.type(screen.getByLabelText("Manager Email"), "mgr@example.com");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows API error on failure", async () => {
    server.use(
      http.post("http://localhost/api/admin/buildings", () => {
        return HttpResponse.json({ detail: "Building already exists" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    await user.type(screen.getByLabelText("Building Name"), "Existing Tower");
    await user.type(screen.getByLabelText("Manager Email"), "mgr@example.com");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  // --- US-ACC-08: required field markers ---

  it("Building Name input has aria-required='true'", () => {
    renderComponent();
    expect(screen.getByLabelText("Building Name")).toHaveAttribute("aria-required", "true");
  });

  it("Manager Email input has aria-required='true'", () => {
    renderComponent();
    expect(screen.getByLabelText("Manager Email")).toHaveAttribute("aria-required", "true");
  });
});
