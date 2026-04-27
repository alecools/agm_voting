import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import BuildingCSVUpload from "../BuildingCSVUpload";

function renderComponent(onSuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BuildingCSVUpload onSuccess={onSuccess} />
    </QueryClientProvider>
  );
}

describe("BuildingCSVUpload", () => {
  it("renders file input and choose file button", () => {
    renderComponent();
    expect(screen.getByLabelText("Buildings file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
  });

  it("shows success message with created/updated counts after upload", async () => {
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["building_name,manager_email\nTest,t@t.com"], "buildings.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Buildings file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 2 created, 1 updated/)).toBeInTheDocument();
    });
  });

  it("shows error message on upload failure", async () => {
    server.use(
      http.post("http://localhost/api/admin/buildings/import", () => {
        return HttpResponse.json({ detail: "Missing required CSV headers" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Buildings file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });

  it("calls onSuccess after successful upload", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["building_name,manager_email\nTest,t@t.com"], "buildings.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Buildings file"), file);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("accepts .xlsx files and uploads successfully", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["xlsx binary data"], "buildings.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(screen.getByLabelText("Buildings file"), file);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("does nothing when no file selected and choose file not clicked", () => {
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
