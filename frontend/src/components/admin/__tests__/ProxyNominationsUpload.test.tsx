import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import ProxyNominationsUpload from "../ProxyNominationsUpload";

function renderComponent(onSuccess = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProxyNominationsUpload buildingId="b1" onSuccess={onSuccess} />
    </QueryClientProvider>
  );
}

describe("ProxyNominationsUpload", () => {
  it("renders file input and choose file button", () => {
    renderComponent();
    expect(screen.getByLabelText("Proxy nominations file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
  });

  it("shows success message with counts after upload", async () => {
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["Lot#,Proxy Email\n1A,proxy@test.com"], "proxies.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 3 upserted, 1 removed, 0 skipped/)).toBeInTheDocument();
    });
  });

  it("shows error message on upload failure", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import-proxies", () => {
        return HttpResponse.json({ detail: "Missing required CSV headers" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });

  it("calls onSuccess after successful upload", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["Lot#,Proxy Email\n1A,proxy@test.com"], "proxies.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("accepts .xlsx files and uploads successfully", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderComponent(onSuccess);
    const file = new File(["xlsx binary data"], "proxies.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
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
    // Delay the response so we can catch the pending state
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import-proxies", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ upserted: 1, removed: 0, skipped: 0 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["Lot#,Proxy Email\n1A,p@p.com"], "proxies.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeInTheDocument();
    // wait for completion
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Uploading..." })).not.toBeInTheDocument();
    });
  });

  it("shows selected filename while uploading", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners/import-proxies", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ upserted: 1, removed: 0, skipped: 0 });
      })
    );
    const user = userEvent.setup();
    renderComponent();
    const file = new File(["Lot#,Proxy Email\n1A,p@p.com"], "my-proxies.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    expect(screen.getByText("my-proxies.csv")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("my-proxies.csv")).not.toBeInTheDocument();
    });
  });
});
