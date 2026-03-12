import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import FinancialPositionUpload from "../FinancialPositionUpload";

function renderComponent(onSuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FinancialPositionUpload buildingId="b1" onSuccess={onSuccess} />
    </QueryClientProvider>
  );
}

describe("FinancialPositionUpload", () => {
  it("renders file input and choose file button", () => {
    renderComponent();
    expect(screen.getByLabelText("Financial positions file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
  });

  it("shows success message with counts after upload", async () => {
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["Lot#,Financial Position\n1A,Normal"], "fp.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 4 updated, 0 skipped/)).toBeInTheDocument();
    });
  });

  it("shows error message on upload failure", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import-financial-positions", () => {
        return HttpResponse.json({ detail: "Missing required CSV headers" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });

  it("calls onSuccess after successful upload", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["Lot#,Financial Position\n1A,Normal"], "fp.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("accepts .xlsx files and uploads successfully", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["xlsx binary data"], "fp.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("does nothing when no file selected", () => {
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("shows uploading state while pending", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import-financial-positions", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ updated: 2, skipped: 0 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["Lot#,Financial Position\n1A,Normal"], "fp.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Uploading..." })).not.toBeInTheDocument();
    });
  });

  it("shows selected filename while uploading", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import-financial-positions", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ updated: 2, skipped: 0 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["Lot#,Financial Position\n1A,Normal"], "my-fp.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    expect(screen.getByText("my-fp.csv")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("my-fp.csv")).not.toBeInTheDocument();
    });
  });
});
