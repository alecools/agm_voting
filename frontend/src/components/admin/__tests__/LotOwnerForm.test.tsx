import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import LotOwnerForm from "../LotOwnerForm";
import type { LotOwner } from "../../../types";

const existingLotOwner: LotOwner = {
  id: "lo1",
  building_id: "b1",
  lot_number: "1A",
  email: "owner1@example.com",
  unit_entitlement: 100,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

function renderAddForm(onSuccess = vi.fn(), onCancel = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LotOwnerForm
        buildingId="b1"
        editTarget={null}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    </QueryClientProvider>
  );
}

function renderEditForm(lotOwner: LotOwner, onSuccess = vi.fn(), onCancel = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LotOwnerForm
        buildingId="b1"
        editTarget={lotOwner}
        onSuccess={onSuccess}
        onCancel={onCancel}
      />
    </QueryClientProvider>
  );
}

describe("LotOwnerForm - Add mode", () => {
  it("renders add form fields", () => {
    renderAddForm();
    expect(screen.getByLabelText("Lot Number")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Unit Entitlement")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Lot Owner" })).toBeInTheDocument();
  });

  it("submits add form and calls onSuccess", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderAddForm(onSuccess);
    await user.type(screen.getByLabelText("Lot Number"), "3C");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "150");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows 409 duplicate error", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.type(screen.getByLabelText("Lot Number"), "DUPLICATE");
    await user.type(screen.getByLabelText("Email"), "dup@example.com");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  it("shows validation error when lot number is empty", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.type(screen.getByLabelText("Email"), "email@example.com");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    expect(screen.getByText("Lot number is required.")).toBeInTheDocument();
  });

  it("shows validation error when email is empty", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.type(screen.getByLabelText("Lot Number"), "5E");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    expect(screen.getByText("Email is required.")).toBeInTheDocument();
  });

  it("shows validation error when unit entitlement is not a number", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.type(screen.getByLabelText("Lot Number"), "5E");
    await user.type(screen.getByLabelText("Email"), "e@e.com");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "abc");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    expect(screen.getByText("Unit entitlement must be a valid integer.")).toBeInTheDocument();
  });

  it("shows validation error when unit entitlement is negative", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.type(screen.getByLabelText("Lot Number"), "5E");
    await user.type(screen.getByLabelText("Email"), "e@e.com");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "-5");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    expect(screen.getByText("Unit entitlement must be >= 0.")).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderAddForm(vi.fn(), onCancel);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("LotOwnerForm - Edit mode", () => {
  it("renders edit form with existing values", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByLabelText("Email")).toHaveValue("owner1@example.com");
    expect(screen.getByLabelText("Unit Entitlement")).toHaveValue(100);
    expect(screen.queryByLabelText("Lot Number")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();
  });

  it("submits edit form and calls onSuccess", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(existingLotOwner, onSuccess);
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "updated@example.com");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows validation error for negative entitlement on edit (client-side)", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    // Clear and type negative value
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "-10");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("Unit entitlement must be >= 0.")).toBeInTheDocument();
  });

  it("shows no changes error when values unchanged", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("No changes detected.")).toBeInTheDocument();
  });

  it("updates email field in edit mode", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm({ ...existingLotOwner, email: "old@example.com", unit_entitlement: 50 }, onSuccess);
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "changed@example.com");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows server error message on edit mutation failure", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/lot-owners/:lotOwnerId", () => {
        return HttpResponse.json({ detail: "Server error" }, { status: 500 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    // Change email so it's different from existing
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "newemail@example.com");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });
  });

  it("submits edit with changed unit entitlement only", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(existingLotOwner, onSuccess);
    // Change only unit entitlement (different from 100)
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "999");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("resets form when editTarget changes", async () => {
    const { rerender } = renderEditForm(existingLotOwner);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <LotOwnerForm
          buildingId="b1"
          editTarget={{ ...existingLotOwner, email: "other@example.com", id: "lo2" }}
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>
    );
    expect(screen.getByLabelText("Email")).toHaveValue("other@example.com");
  });
});
