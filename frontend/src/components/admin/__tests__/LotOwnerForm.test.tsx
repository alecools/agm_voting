import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import LotOwnerForm from "../LotOwnerForm";
import { addEmailToLotOwner, getLotOwner, removeEmailFromLotOwner, setLotOwnerProxy, removeLotOwnerProxy } from "../../../api/admin";
import type { LotOwner } from "../../../types";

const existingLotOwner: LotOwner = {
  id: "lo1",
  building_id: "b1",
  lot_number: "1A",
  emails: ["owner1@example.com"],
  unit_entitlement: 100,
  financial_position: "normal",
  proxy_email: null,
};

const multiEmailOwner: LotOwner = {
  ...existingLotOwner,
  id: "lo1",
  emails: ["owner1@example.com", "second@example.com"],
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

// ---------------------------------------------------------------------------
// Add mode
// ---------------------------------------------------------------------------
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

  it("submits add form with no email and calls onSuccess", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderAddForm(onSuccess);
    await user.type(screen.getByLabelText("Lot Number"), "5E");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    // email left blank intentionally
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows validation error for malformed email format", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.type(screen.getByLabelText("Lot Number"), "5E");
    // Use a value that has an @ but no dot in the domain so it fails our regex but
    // userEvent can type it into a type="email" input without jsdom sanitizing it away
    await user.type(screen.getByLabelText("Email"), "user@nodot");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();
  });

  it("email input in add form has type=text (allows empty submission)", () => {
    renderAddForm();
    const emailInput = screen.getByLabelText("Email");
    expect(emailInput).toHaveAttribute("type", "text");
  });

  it("shows hint text below email input", () => {
    renderAddForm();
    expect(screen.getByText("Leave blank if no email address")).toBeInTheDocument();
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

  it("renders the add dialog with role=dialog and aria-modal", () => {
    renderAddForm();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("calls onCancel when Escape key is pressed in add modal", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderAddForm(vi.fn(), onCancel);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when clicking the backdrop overlay outside the add dialog", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderAddForm(vi.fn(), onCancel);
    const overlay = screen.getByRole("dialog");
    await user.click(overlay);
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not call onCancel when clicking inside the add dialog content", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderAddForm(vi.fn(), onCancel);
    await user.click(screen.getByRole("heading", { name: "Add Lot Owner" }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Add mode — financial position
// ---------------------------------------------------------------------------
describe("LotOwnerForm - Add mode financial position", () => {
  it("renders financial position dropdown in add mode defaulting to normal", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { getByLabelText } = render(
      <QueryClientProvider client={queryClient}>
        <LotOwnerForm buildingId="b1" editTarget={null} onSuccess={vi.fn()} onCancel={vi.fn()} />
      </QueryClientProvider>
    );
    const select = getByLabelText("Financial Position");
    expect(select).toHaveValue("normal");
  });

  it("submits add form with in_arrear financial position", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LotOwnerForm buildingId="b1" editTarget={null} onSuccess={onSuccess} onCancel={vi.fn()} />
      </QueryClientProvider>
    );
    await user.type(screen.getByLabelText("Lot Number"), "3C");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "150");
    await user.selectOptions(screen.getByLabelText("Financial Position"), "in_arrear");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Edit modal — core behaviour
// ---------------------------------------------------------------------------
describe("LotOwnerForm - Edit modal", () => {
  it("renders modal with existing values", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByRole("heading", { name: "Edit Lot Owner" })).toBeInTheDocument();
    expect(screen.getByLabelText("Unit Entitlement")).toHaveValue(100);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();
  });

  it("does not render lot number or email fields (add-mode only)", () => {
    renderEditForm(existingLotOwner);
    expect(screen.queryByLabelText("Lot Number")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("renders the dialog with role=dialog and aria-modal", () => {
    renderEditForm(existingLotOwner);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("shows existing email addresses in the list", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByText("owner1@example.com")).toBeInTheDocument();
  });

  it("shows multiple emails when owner has more than one", () => {
    renderEditForm(multiEmailOwner);
    expect(screen.getByText("owner1@example.com")).toBeInTheDocument();
    expect(screen.getByText("second@example.com")).toBeInTheDocument();
  });

  it("submits edit form with changed unit entitlement and calls onSuccess", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(existingLotOwner, onSuccess);
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "999");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("shows validation error for negative entitlement (client-side)", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "-10");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("Unit entitlement must be >= 0.")).toBeInTheDocument();
  });

  it("shows validation error when unit entitlement is not a number (edit modal)", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "abc");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("Unit entitlement must be a valid integer.")).toBeInTheDocument();
  });

  it("shows no changes error when values unchanged", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("No changes detected.")).toBeInTheDocument();
  });

  it("shows server error message on edit mutation failure", async () => {
    server.use(
      http.patch("http://localhost:8000/api/admin/lot-owners/:lotOwnerId", () => {
        return HttpResponse.json({ detail: "Server error" }, { status: 500 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "999");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });
  });

  it("submits with changed unit entitlement only", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(existingLotOwner, onSuccess);
    const entitlementInput = screen.getByLabelText("Unit Entitlement");
    await user.clear(entitlementInput);
    await user.type(entitlementInput, "999");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("renders financial position dropdown in edit modal with current value", () => {
    renderEditForm({ ...existingLotOwner, financial_position: "in_arrear" });
    const select = screen.getByLabelText("Financial Position");
    expect(select).toHaveValue("in_arrear");
  });

  it("submits with changed financial position", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(existingLotOwner, onSuccess);
    await user.selectOptions(screen.getByLabelText("Financial Position"), "in_arrear");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("resets form when editTarget changes via rerender", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <LotOwnerForm
          buildingId="b1"
          editTarget={existingLotOwner}
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>
    );
    rerender(
      <QueryClientProvider client={queryClient}>
        <LotOwnerForm
          buildingId="b1"
          editTarget={{ ...existingLotOwner, unit_entitlement: 999, id: "lo2" }}
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>
    );
    expect(screen.getByLabelText("Unit Entitlement")).toHaveValue(999);
  });
});

// ---------------------------------------------------------------------------
// Edit modal — close behaviours (US-UI02)
// ---------------------------------------------------------------------------
describe("LotOwnerForm - Edit modal close behaviours", () => {
  it("calls onCancel when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderEditForm(existingLotOwner, vi.fn(), onCancel);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when Escape key is pressed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderEditForm(existingLotOwner, vi.fn(), onCancel);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when clicking the backdrop (overlay) outside the dialog", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderEditForm(existingLotOwner, vi.fn(), onCancel);
    const overlay = screen.getByRole("dialog");
    // Click directly on the overlay element (not a child)
    await user.click(overlay);
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not call onCancel when clicking inside the dialog content", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderEditForm(existingLotOwner, vi.fn(), onCancel);
    // Clicking on the heading inside the dialog should NOT close it
    await user.click(screen.getByRole("heading", { name: "Edit Lot Owner" }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Email management (US-UI03)
// ---------------------------------------------------------------------------
describe("LotOwnerForm - Edit modal email management", () => {
  it("renders Add email input and button", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByLabelText("Add email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add email" })).toBeInTheDocument();
  });

  it("shows validation error when adding empty email", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: "Add email" }));
    expect(screen.getByText("Email is required.")).toBeInTheDocument();
  });

  it("shows validation error for invalid email format", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Add email" }));
    expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();
  });

  it("adds a new email successfully", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add email"), "added@example.com");
    await user.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() => {
      expect(screen.getByText("added@example.com")).toBeInTheDocument();
    });
  });

  it("clears the add email input after successful add", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add email"), "added@example.com");
    await user.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Add email")).toHaveValue("");
    });
  });

  it("adds email when Enter key is pressed in the add email input", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add email"), "entered@example.com");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByText("entered@example.com")).toBeInTheDocument();
    });
  });

  it("shows server error when add email API fails", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/emails", () => {
        return HttpResponse.json({ detail: "Conflict" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add email"), "dup@example.com");
    await user.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  it("normalises email to lowercase before calling add email API", async () => {
    let capturedEmail: string | undefined;
    server.use(
      http.post("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/emails", async ({ request }) => {
        const body = await request.json() as { email?: string };
        capturedEmail = body?.email;
        const updated = { ...existingLotOwner, emails: [...existingLotOwner.emails, capturedEmail ?? ""] };
        return HttpResponse.json(updated);
      })
    );
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add email"), "UPPER@EXAMPLE.COM");
    await user.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() => {
      expect(capturedEmail).toBe("upper@example.com");
    });
  });

  it("renders Remove button for each email", () => {
    renderEditForm(multiEmailOwner);
    const removeButtons = screen.getAllByRole("button", { name: /^Remove / });
    expect(removeButtons).toHaveLength(2);
  });

  it("removes an email successfully when owner has multiple emails", async () => {
    const user = userEvent.setup();
    renderEditForm(multiEmailOwner);
    const removeButton = screen.getByRole("button", { name: "Remove owner1@example.com" });
    await user.click(removeButton);
    await waitFor(() => {
      // The MSW handler returns lo1 emails minus the removed one
      expect(screen.queryByText("owner1@example.com")).not.toBeInTheDocument();
    });
  });

  it("allows removal of the last email (zero-email owners are valid)", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner); // only one email
    await user.click(screen.getByRole("button", { name: "Remove owner1@example.com" }));
    await waitFor(() => {
      expect(screen.queryByText("owner1@example.com")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText("A lot owner must have at least one email address.")
    ).not.toBeInTheDocument();
  });

  it("shows server error when remove email API fails", async () => {
    server.use(
      http.delete("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/emails/:email", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(multiEmailOwner);
    const removeButton = screen.getByRole("button", { name: "Remove owner1@example.com" });
    await user.click(removeButton);
    await waitFor(() => {
      expect(screen.getByText(/404/)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// API function coverage
// ---------------------------------------------------------------------------
describe("addEmailToLotOwner API function", () => {
  it("adds an email and returns updated lot owner", async () => {
    const result = await addEmailToLotOwner("lo1", "added@example.com");
    expect(result.emails).toContain("added@example.com");
  });

  it("handles server error when adding email", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/emails", () => {
        return HttpResponse.json({ detail: "Conflict" }, { status: 409 });
      })
    );
    await expect(addEmailToLotOwner("lo1", "dup@example.com")).rejects.toThrow();
  });
});

describe("removeEmailFromLotOwner API function", () => {
  it("removes an email and returns updated lot owner", async () => {
    const result = await removeEmailFromLotOwner("lo1", "owner1@example.com");
    expect(result.emails).not.toContain("owner1@example.com");
  });

  it("handles server error when removing email", async () => {
    server.use(
      http.delete("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/emails/:email", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    await expect(removeEmailFromLotOwner("lo1", "nonexistent@example.com")).rejects.toThrow();
  });
});

describe("getLotOwner API function", () => {
  it("returns lot owner with proxy_email when proxy is nominated", async () => {
    const result = await getLotOwner("lo2");
    expect(result.lot_number).toBe("2B");
    expect(result.proxy_email).toBe("proxy@example.com");
  });

  it("returns lot owner with null proxy_email when no proxy is set", async () => {
    const result = await getLotOwner("lo1");
    expect(result.lot_number).toBe("1A");
    expect(result.proxy_email).toBeNull();
  });

  it("handles 404 error when lot owner not found", async () => {
    await expect(getLotOwner("lo-nonexistent")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LotOwnerForm - Edit modal proxy management (US-PX08)
// ---------------------------------------------------------------------------

const lotOwnerWithoutProxy: LotOwner = {
  id: "lo1",
  building_id: "b1",
  lot_number: "1A",
  emails: ["owner1@example.com"],
  unit_entitlement: 100,
  financial_position: "normal",
  proxy_email: null,
};

const lotOwnerWithProxy: LotOwner = {
  id: "lo2",
  building_id: "b1",
  lot_number: "2B",
  emails: ["owner2@example.com"],
  unit_entitlement: 200,
  financial_position: "normal",
  proxy_email: "proxy@example.com",
};

describe("LotOwnerForm - Edit modal proxy management", () => {
  // --- Happy path ---

  it("shows Set proxy input and button when proxy_email is null", () => {
    renderEditForm(lotOwnerWithoutProxy);
    expect(screen.getByLabelText("Set proxy email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set proxy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove proxy" })).not.toBeInTheDocument();
  });

  it("shows proxy email and Remove proxy button when proxy_email is set", () => {
    renderEditForm(lotOwnerWithProxy);
    expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove proxy" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Set proxy email")).not.toBeInTheDocument();
  });

  it("sets proxy successfully and shows new proxy email with Remove proxy button", async () => {
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    await user.type(screen.getByLabelText("Set proxy email"), "newproxy@example.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("newproxy@example.com")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove proxy" })).toBeInTheDocument();
    });
  });

  it("removes proxy successfully and shows input and Set proxy button", async () => {
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithProxy);
    await user.click(screen.getByRole("button", { name: "Remove proxy" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Set proxy email")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Set proxy" })).toBeInTheDocument();
    });
  });

  // --- Input validation ---

  it("shows 'Proxy email is required.' when Set proxy clicked with empty input", async () => {
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    expect(screen.getByText("Proxy email is required.")).toBeInTheDocument();
  });

  it("shows 'Please enter a valid email address.' for invalid proxy email", async () => {
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    await user.type(screen.getByLabelText("Set proxy email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();
  });

  // --- Error handling ---

  it("shows error message when set proxy API fails", async () => {
    server.use(
      http.put("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/proxy", () => {
        return HttpResponse.json({ detail: "Server error" }, { status: 500 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    await user.type(screen.getByLabelText("Set proxy email"), "proxy@example.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });
  });

  it("shows error message when remove proxy API fails", async () => {
    server.use(
      http.delete("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/proxy", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithProxy);
    await user.click(screen.getByRole("button", { name: "Remove proxy" }));
    await waitFor(() => {
      expect(screen.getByText(/404/)).toBeInTheDocument();
    });
  });

  // --- UX fix: No changes detected suppressed when emails modified (Issue A) ---

  it("calls onSuccess instead of showing 'No changes detected' after adding an email", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(lotOwnerWithoutProxy, onSuccess);
    // Add an email
    await user.type(screen.getByLabelText("Add email"), "added@example.com");
    await user.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() => {
      expect(screen.getByText("added@example.com")).toBeInTheDocument();
    });
    // Click Save Changes without changing entitlement/financial position
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(screen.queryByText("No changes detected.")).not.toBeInTheDocument();
  });

  it("after setting a proxy, Save Changes calls onSuccess instead of showing no-changes error", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm({ ...existingLotOwner, proxy_email: null }, onSuccess);
    await user.type(screen.getByLabelText("Set proxy email"), "proxy@example.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(screen.queryByText("No changes detected.")).not.toBeInTheDocument();
  });

  it("after removing a proxy, Save Changes calls onSuccess instead of showing no-changes error", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    // lo2 has proxy_email: "proxy@example.com" in the MSW fixture — use lotOwnerWithProxy so the
    // DELETE handler finds the proxy and returns 200 instead of 404
    renderEditForm(lotOwnerWithProxy, onSuccess);
    await user.click(screen.getByRole("button", { name: "Remove proxy" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Set proxy email")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(screen.queryByText("No changes detected.")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// API function coverage — setLotOwnerProxy / removeLotOwnerProxy
// ---------------------------------------------------------------------------

describe("setLotOwnerProxy API function", () => {
  it("sets proxy and returns updated lot owner with proxy_email", async () => {
    const result = await setLotOwnerProxy("lo1", "proxy@example.com");
    expect(result.proxy_email).toBe("proxy@example.com");
  });

  it("handles server error when setting proxy", async () => {
    server.use(
      http.put("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/proxy", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    await expect(setLotOwnerProxy("lo-nonexistent", "proxy@example.com")).rejects.toThrow();
  });
});

describe("removeLotOwnerProxy API function", () => {
  it("removes proxy and returns updated lot owner with null proxy_email", async () => {
    const result = await removeLotOwnerProxy("lo2");
    expect(result.proxy_email).toBeNull();
  });

  it("handles 404 when no proxy to remove", async () => {
    server.use(
      http.delete("http://localhost:8000/api/admin/lot-owners/:lotOwnerId/proxy", () => {
        return HttpResponse.json({ detail: "No proxy nomination found for this lot owner" }, { status: 404 });
      })
    );
    await expect(removeLotOwnerProxy("lo1")).rejects.toThrow();
  });
});
