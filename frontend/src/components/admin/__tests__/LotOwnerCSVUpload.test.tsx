import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import LotOwnerCSVUpload from "../LotOwnerCSVUpload";

function renderComponent(onSuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LotOwnerCSVUpload buildingId="b1" onSuccess={onSuccess} />
    </QueryClientProvider>
  );
}

describe("LotOwnerCSVUpload", () => {
  it("renders file input and upload button", () => {
    renderComponent();
    expect(screen.getByLabelText("Lot owners file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("shows success message with imported count after upload", async () => {
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["lot_number,email,unit_entitlement\n1A,a@a.com,100"], "owners.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Lot owners file"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 5 records imported/)).toBeInTheDocument();
    });
  });

  it("shows error message on upload failure", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import", () => {
        return HttpResponse.json({ detail: "Missing required CSV headers" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Lot owners file"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });

  it("calls onSuccess after successful upload", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["lot_number,email,unit_entitlement\n1A,a@a.com,100"], "owners.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Lot owners file"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("accepts .xlsx files and uploads successfully", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["xlsx binary data"], "owners.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(screen.getByLabelText("Lot owners file"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("does nothing when no file selected", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
