import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import LotOwnerForm from "../LotOwnerForm";
import {
  addEmailToLotOwner,
  getLotOwner,
  removeEmailFromLotOwner,
  addOwnerEmailToLotOwner,
  updateOwnerEmail,
  removeOwnerEmailById,
  setLotOwnerProxy,
  removeLotOwnerProxy,
} from "../../../api/admin";
import type { LotOwner } from "../../../types";

const existingLotOwner: LotOwner = {
  id: "lo1",
  building_id: "b1",
  lot_number: "1A",
  given_name: null,
  surname: null,
  owner_emails: [{ id: "em1", email: "owner1@example.com", given_name: null, surname: null, phone_number: null }],
  emails: ["owner1@example.com"],
  unit_entitlement: 100,
  financial_position: "normal",
  proxy_email: null,
  proxy_given_name: null,
  proxy_surname: null,
};

const multiEmailOwner: LotOwner = {
  ...existingLotOwner,
  id: "lo1",
  owner_emails: [
    { id: "em1", email: "owner1@example.com", given_name: null, surname: null },
    { id: "em2", email: "second@example.com", given_name: null, surname: null },
  ],
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

  it("email input in add form has type=email (RR3-28)", () => {
    renderAddForm();
    const emailInput = screen.getByLabelText("Email");
    expect(emailInput).toHaveAttribute("type", "email");
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
      http.patch("http://localhost/api/admin/lot-owners/:lotOwnerId", () => {
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
  it("renders Add owner email input and button", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByLabelText("Add owner email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add owner" })).toBeInTheDocument();
  });

  it("shows validation error when adding empty email", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    expect(screen.getByText("Email is required.")).toBeInTheDocument();
  });

  it("shows validation error for invalid email format", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add owner email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();
  });

  it("adds a new email successfully", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add owner email"), "added@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    await waitFor(() => {
      expect(screen.getByText("added@example.com")).toBeInTheDocument();
    });
  });

  it("clears the add email input after successful add", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add owner email"), "added@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Add owner email")).toHaveValue("");
    });
  });

  it("adds email when Enter key is pressed in the add email input", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add owner email"), "entered@example.com");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByText("entered@example.com")).toBeInTheDocument();
    });
  });

  it("shows server error when add email API fails", async () => {
    server.use(
      http.post("http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails", () => {
        return HttpResponse.json({ detail: "Conflict" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add owner email"), "dup@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  it("normalises email to lowercase before calling add email API", async () => {
    let capturedEmail: string | undefined;
    server.use(
      http.post("http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails", async ({ request }) => {
        const body = await request.json() as { email?: string };
        capturedEmail = body?.email;
        const updated = {
          ...existingLotOwner,
          owner_emails: [...existingLotOwner.owner_emails, { id: "em-new", email: capturedEmail ?? "", given_name: null, surname: null }],
          emails: [...existingLotOwner.emails, capturedEmail ?? ""],
        };
        return HttpResponse.json(updated, { status: 201 });
      })
    );
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Add owner email"), "UPPER@EXAMPLE.COM");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
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
      http.delete("http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails/:emailId", () => {
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
// API function coverage — new owner-emails endpoints
// ---------------------------------------------------------------------------
describe("addOwnerEmailToLotOwner API function", () => {
  it("adds an owner email with names and returns updated lot owner", async () => {
    const result = await addOwnerEmailToLotOwner("lo1", {
      email: "added@example.com",
      given_name: "Jane",
      surname: "Smith",
    });
    const found = result.owner_emails.find((e) => e.email === "added@example.com");
    expect(found).toBeDefined();
  });

  it("handles server error when adding owner email", async () => {
    server.use(
      http.post("http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails", () => {
        return HttpResponse.json({ detail: "Conflict" }, { status: 409 });
      })
    );
    await expect(
      addOwnerEmailToLotOwner("lo1", { email: "dup@example.com" })
    ).rejects.toThrow();
  });
});

describe("updateOwnerEmail API function", () => {
  it("updates owner email and returns updated lot owner", async () => {
    const result = await updateOwnerEmail("lo1", "em1", { given_name: "Jane" });
    expect(result.owner_emails).toBeDefined();
  });

  it("handles server error when updating owner email", async () => {
    server.use(
      http.patch("http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails/:emailId", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    await expect(updateOwnerEmail("lo1", "em-nonexistent", { given_name: "Jane" })).rejects.toThrow();
  });
});

describe("removeOwnerEmailById API function", () => {
  it("removes owner email and returns updated lot owner", async () => {
    const result = await removeOwnerEmailById("lo1", "em1");
    expect(result).toBeDefined();
  });

  it("handles server error when removing owner email", async () => {
    server.use(
      http.delete("http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails/:emailId", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    await expect(removeOwnerEmailById("lo1", "em-nonexistent")).rejects.toThrow();
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
      http.post("http://localhost/api/admin/lot-owners/:lotOwnerId/emails", () => {
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
      http.delete("http://localhost/api/admin/lot-owners/:lotOwnerId/emails/:email", () => {
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
  given_name: null,
  surname: null,
  owner_emails: [{ id: "em1", email: "owner1@example.com", given_name: null, surname: null }],
  emails: ["owner1@example.com"],
  unit_entitlement: 100,
  financial_position: "normal",
  proxy_email: null,
  proxy_given_name: null,
  proxy_surname: null,
};

const lotOwnerWithProxy: LotOwner = {
  id: "lo2",
  building_id: "b1",
  lot_number: "2B",
  given_name: null,
  surname: null,
  owner_emails: [{ id: "em2", email: "owner2@example.com", given_name: null, surname: null }],
  emails: ["owner2@example.com"],
  unit_entitlement: 200,
  financial_position: "normal",
  proxy_email: "proxy@example.com",
  proxy_given_name: null,
  proxy_surname: null,
};

describe("LotOwnerForm - Edit modal proxy management", () => {
  // --- Happy path ---

  it("shows proxy name inputs, email input and Set proxy button when proxy_email is null", () => {
    renderEditForm(lotOwnerWithoutProxy);
    expect(screen.getByLabelText("Proxy given name")).toBeInTheDocument();
    expect(screen.getByLabelText("Proxy surname")).toBeInTheDocument();
    expect(screen.getByLabelText("Set proxy email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set proxy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove proxy" })).not.toBeInTheDocument();
  });

  it("shows proxy email and Remove proxy button when proxy_email is set (no name)", () => {
    renderEditForm(lotOwnerWithProxy);
    expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove proxy" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Set proxy email")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Proxy given name")).not.toBeInTheDocument();
  });

  it("shows '— no name —' placeholder in proxy section when proxy is set but has no name", () => {
    renderEditForm(lotOwnerWithProxy);
    // Multiple "— no name —" may appear (owner emails + proxy) — assert at least one is present
    expect(screen.getAllByText("— no name —").length).toBeGreaterThan(0);
    // Proxy section shows the remove button when proxy is set
    expect(screen.getByRole("button", { name: "Remove proxy" })).toBeInTheDocument();
  });

  it("shows proxy name + email when proxy is set with names", () => {
    const loWithNamedProxy: LotOwner = {
      ...lotOwnerWithProxy,
      proxy_given_name: "Jane",
      proxy_surname: "Doe",
    };
    renderEditForm(loWithNamedProxy);
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
  });

  it("sets proxy successfully and shows new proxy email with Remove proxy button", async () => {
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    await user.type(screen.getByLabelText("Set proxy email"), "newproxy@example.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("newproxy@example.com")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove proxy" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Set proxy email")).not.toBeInTheDocument();
    });
  });

  it("sets proxy with given name and surname — calls setLotOwnerProxy with correct name arguments", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", async ({ request, params }) => {
        capturedBody = await request.json();
        const body = capturedBody as { proxy_email?: string; given_name?: string | null; surname?: string | null };
        const updated: LotOwner = {
          ...lotOwnerWithoutProxy,
          id: params.lotOwnerId as string,
          proxy_email: body?.proxy_email ?? null,
          proxy_given_name: body?.given_name ?? null,
          proxy_surname: body?.surname ?? null,
        };
        return HttpResponse.json(updated);
      })
    );
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    await user.type(screen.getByLabelText("Proxy given name"), "Jane");
    await user.type(screen.getByLabelText("Proxy surname"), "Doe");
    await user.type(screen.getByLabelText("Set proxy email"), "jane@proxy.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("jane@proxy.com")).toBeInTheDocument();
    });
    expect((capturedBody as Record<string, unknown>)?.given_name).toBe("Jane");
    expect((capturedBody as Record<string, unknown>)?.surname).toBe("Doe");
  });

  it("sets proxy with blank name fields — calls setLotOwnerProxy with givenName: null, surname: null", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", async ({ request, params }) => {
        capturedBody = await request.json();
        const body = capturedBody as { proxy_email?: string; given_name?: string | null; surname?: string | null };
        const updated: LotOwner = {
          ...lotOwnerWithoutProxy,
          id: params.lotOwnerId as string,
          proxy_email: body?.proxy_email ?? null,
          proxy_given_name: null,
          proxy_surname: null,
        };
        return HttpResponse.json(updated);
      })
    );
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithoutProxy);
    // Leave name inputs blank
    await user.type(screen.getByLabelText("Set proxy email"), "noop@proxy.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("noop@proxy.com")).toBeInTheDocument();
    });
    expect((capturedBody as Record<string, unknown>)?.given_name).toBeNull();
    expect((capturedBody as Record<string, unknown>)?.surname).toBeNull();
  });

  it("removes proxy successfully and shows name inputs + Set proxy button", async () => {
    const user = userEvent.setup();
    renderEditForm(lotOwnerWithProxy);
    await user.click(screen.getByRole("button", { name: "Remove proxy" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Proxy given name")).toBeInTheDocument();
      expect(screen.getByLabelText("Proxy surname")).toBeInTheDocument();
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
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", () => {
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
      http.delete("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", () => {
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

  // --- Fix 3: proxy name shown immediately after first save (stale prop bug) ---

  it("Fix 3: proxy name is shown immediately after first save without waiting for cache refetch", async () => {
    const user = userEvent.setup();
    // Use a lot owner with a named email (so "— no name —" won't appear from owner section)
    const lotWithNamedEmail: LotOwner = {
      ...lotOwnerWithoutProxy,
      owner_emails: [{ id: "em1", email: "owner1@example.com", given_name: "Alice", surname: "Smith" }],
    };
    // Override the MSW handler so it returns proxy_given_name and proxy_surname
    server.use(
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", async ({ request, params }) => {
        const body = await request.json() as { proxy_email?: string; given_name?: string | null; surname?: string | null };
        const updated: LotOwner = {
          ...lotWithNamedEmail,
          id: params.lotOwnerId as string,
          proxy_email: body?.proxy_email ?? null,
          proxy_given_name: body?.given_name ?? null,
          proxy_surname: body?.surname ?? null,
        };
        return HttpResponse.json(updated);
      })
    );
    renderEditForm(lotWithNamedEmail);
    await user.type(screen.getByLabelText("Proxy given name"), "Jane");
    await user.type(screen.getByLabelText("Proxy surname"), "Doe");
    await user.type(screen.getByLabelText("Set proxy email"), "jane@proxy.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    // After mutation resolves, the proxy display should show the name immediately
    // (from local state, not the stale lotOwner prop)
    await waitFor(() => {
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });
    // The proxy section shows Remove proxy (not Set proxy), confirming it used local state
    expect(screen.getByRole("button", { name: "Remove proxy" })).toBeInTheDocument();
  });

  it("Fix 3: proxy name shown correctly on second save too (regression check)", async () => {
    const user = userEvent.setup();
    // Use a lot owner with a named email so "— no name —" won't confuse assertions
    const lotWithNamedEmail: LotOwner = {
      ...lotOwnerWithoutProxy,
      owner_emails: [{ id: "em1", email: "owner1@example.com", given_name: "Alice", surname: "Smith" }],
    };
    // Override PUT proxy handler to echo back the names
    server.use(
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", async ({ request, params }) => {
        const body = await request.json() as { proxy_email?: string; given_name?: string | null; surname?: string | null };
        const updated: LotOwner = {
          ...lotWithNamedEmail,
          id: params.lotOwnerId as string,
          proxy_email: body?.proxy_email ?? null,
          proxy_given_name: body?.given_name ?? null,
          proxy_surname: body?.surname ?? null,
        };
        return HttpResponse.json(updated);
      })
    );
    // Override DELETE proxy handler to succeed
    server.use(
      http.delete("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", ({ params }) => {
        const updated: LotOwner = {
          ...lotWithNamedEmail,
          id: params.lotOwnerId as string,
          proxy_email: null,
          proxy_given_name: null,
          proxy_surname: null,
        };
        return HttpResponse.json(updated);
      })
    );
    renderEditForm(lotWithNamedEmail);
    await user.type(screen.getByLabelText("Proxy given name"), "Jane");
    await user.type(screen.getByLabelText("Proxy surname"), "Doe");
    await user.type(screen.getByLabelText("Set proxy email"), "jane@proxy.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });
    // Remove proxy to reset to the set-proxy form
    await user.click(screen.getByRole("button", { name: "Remove proxy" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Set proxy email")).toBeInTheDocument();
    });
    // Second save with a different name
    await user.type(screen.getByLabelText("Proxy given name"), "Bob");
    await user.type(screen.getByLabelText("Proxy surname"), "Smith");
    await user.type(screen.getByLabelText("Set proxy email"), "bob@proxy.com");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      expect(screen.getByText("Bob Smith")).toBeInTheDocument();
      expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
    });
  });

  // --- UX fix: No changes detected suppressed when emails modified (Issue A) ---

  it("calls onSuccess instead of showing 'No changes detected' after adding an email", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderEditForm(lotOwnerWithoutProxy, onSuccess);
    // Add an email
    await user.type(screen.getByLabelText("Add owner email"), "added@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
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

  it("sets proxy with names and response includes proxy_given_name and proxy_surname", async () => {
    server.use(
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", async ({ request, params }) => {
        const body = await request.json() as { proxy_email?: string; given_name?: string | null; surname?: string | null };
        const updated: LotOwner = {
          ...lotOwnerWithoutProxy,
          id: params.lotOwnerId as string,
          proxy_email: body?.proxy_email ?? null,
          proxy_given_name: body?.given_name ?? null,
          proxy_surname: body?.surname ?? null,
        };
        return HttpResponse.json(updated);
      })
    );
    const result = await setLotOwnerProxy("lo1", "proxy@example.com", "Jane", "Doe");
    expect(result.proxy_email).toBe("proxy@example.com");
    expect(result.proxy_given_name).toBe("Jane");
    expect(result.proxy_surname).toBe("Doe");
  });

  it("sets proxy with null names returns proxy_given_name: null and proxy_surname: null", async () => {
    const result = await setLotOwnerProxy("lo1", "proxy@example.com", null, null);
    expect(result.proxy_email).toBe("proxy@example.com");
    expect(result.proxy_given_name).toBeNull();
    expect(result.proxy_surname).toBeNull();
  });

  it("handles server error when setting proxy", async () => {
    server.use(
      http.put("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", () => {
        return HttpResponse.json({ detail: "Not found" }, { status: 404 });
      })
    );
    await expect(setLotOwnerProxy("lo-nonexistent", "proxy@example.com")).rejects.toThrow();
  });
});

describe("removeLotOwnerProxy API function", () => {
  it("removes proxy and returns updated lot owner with null proxy_email, proxy_given_name, and proxy_surname", async () => {
    const result = await removeLotOwnerProxy("lo2");
    expect(result.proxy_email).toBeNull();
    expect(result.proxy_given_name).toBeNull();
    expect(result.proxy_surname).toBeNull();
  });

  it("handles 404 when no proxy to remove", async () => {
    server.use(
      http.delete("http://localhost/api/admin/lot-owners/:lotOwnerId/proxy", () => {
        return HttpResponse.json({ detail: "No proxy nomination found for this lot owner" }, { status: 404 });
      })
    );
    await expect(removeLotOwnerProxy("lo1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RR4-25: Error messages have role="alert"
// ---------------------------------------------------------------------------
describe("LotOwnerForm - RR4-25 error messages have role=alert", () => {
  it("email error in EditModal has role=alert", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    // Type invalid email into add-email input
    await user.type(screen.getByLabelText("Add owner email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveClass("field__error");
    });
  });

  it("proxy error in EditModal has role=alert", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("Set proxy email"), "bad-email");
    await user.click(screen.getByRole("button", { name: "Set proxy" }));
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const proxyAlert = alerts.find((el) => el.textContent?.includes("valid email"));
      expect(proxyAlert).toBeDefined();
    });
  });

  it("formError in EditModal has role=alert when no changes detected", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    // Submit without changing anything
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/No changes detected/i);
    });
  });

  it("formError in AddForm has role=alert when lot number is empty", async () => {
    const user = userEvent.setup();
    renderAddForm();
    await user.clear(screen.getByLabelText("Unit Entitlement"));
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/Lot number is required/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Problem A: top-level given_name/surname inputs are removed from EditModal and AddForm
// ---------------------------------------------------------------------------
describe("LotOwnerForm - Problem A: no top-level name fields", () => {
  it("EditModal does not render a 'Given Name' input for the top-level LotOwner", () => {
    renderEditForm(existingLotOwner);
    expect(document.querySelector('label[for="edit-given-name"]')).toBeNull();
    expect(document.querySelector('#edit-given-name')).toBeNull();
  });

  it("EditModal does not render a 'Surname' input for the top-level LotOwner", () => {
    renderEditForm(existingLotOwner);
    expect(document.querySelector('label[for="edit-surname"]')).toBeNull();
    expect(document.querySelector('#edit-surname')).toBeNull();
  });

  it("AddForm does not render top-level 'Given Name' field", () => {
    renderAddForm();
    expect(document.querySelector('label[for="add-given-name"]')).toBeNull();
    expect(document.querySelector('#add-given-name')).toBeNull();
  });

  it("AddForm does not render top-level 'Surname' field", () => {
    renderAddForm();
    expect(document.querySelector('label[for="add-surname"]')).toBeNull();
    expect(document.querySelector('#add-surname')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// New: EditModal owner-email management (US-BO-02)
// ---------------------------------------------------------------------------
describe("LotOwnerForm - EditModal owner_emails management", () => {
  const ownerWithNames: LotOwner = {
    ...existingLotOwner,
    owner_emails: [
      { id: "em1", email: "owner1@example.com", given_name: "Alice", surname: "Smith" },
    ],
  };

  const ownerWithNoName: LotOwner = {
    ...existingLotOwner,
    owner_emails: [
      { id: "em1", email: "owner1@example.com", given_name: null, surname: null },
    ],
  };

  // --- Happy path ---

  it("renders owner name and email in the list", () => {
    renderEditForm(ownerWithNames);
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("owner1@example.com")).toBeInTheDocument();
  });

  it("renders '— no name —' placeholder when given_name and surname are null", () => {
    renderEditForm(ownerWithNoName);
    expect(screen.getByText("— no name —")).toBeInTheDocument();
  });

  it("renders Edit button for each owner entry", () => {
    renderEditForm(ownerWithNames);
    expect(screen.getByRole("button", { name: "Edit owner1@example.com" })).toBeInTheDocument();
  });

  it("clicking Edit opens inline edit form with pre-filled values", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    expect(screen.getByLabelText("Edit given name")).toHaveValue("Alice");
    expect(screen.getByLabelText("Edit surname")).toHaveValue("Smith");
    expect(screen.getByLabelText("Edit email")).toHaveValue("owner1@example.com");
    // "Save" button appears in the inline edit form
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("clicking Cancel in inline edit closes the inline form", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    // Click the inline "Cancel" button (the one inside the inline edit form)
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    // The inline-edit Cancel is the first one rendered in the list section
    await user.click(cancelButtons[0]);
    // Edit form should be gone
    expect(screen.queryByLabelText("Edit given name")).not.toBeInTheDocument();
  });

  it("saving inline edit calls updateOwnerEmail and updates the list", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch(
        "http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails/:emailId",
        async ({ request }) => {
          const body = await request.json() as { given_name?: string | null };
          const updated: LotOwner = {
            ...ownerWithNames,
            owner_emails: [
              { id: "em1", email: "owner1@example.com", given_name: body?.given_name ?? "Alice", surname: "Smith" },
            ],
            emails: ["owner1@example.com"],
          };
          return HttpResponse.json(updated);
        }
      )
    );
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    await user.clear(screen.getByLabelText("Edit given name"));
    await user.type(screen.getByLabelText("Edit given name"), "Jane");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Edit given name")).not.toBeInTheDocument();
    });
  });

  it("typing in Edit surname field updates the surname value", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    const surnameInput = screen.getByLabelText("Edit surname");
    await user.clear(surnameInput);
    await user.type(surnameInput, "Jones");
    expect(surnameInput).toHaveValue("Jones");
  });

  it("shows validation error in inline edit when email is empty", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    await user.clear(screen.getByLabelText("Edit email"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows validation error in inline edit when email is invalid", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    await user.clear(screen.getByLabelText("Edit email"));
    await user.type(screen.getByLabelText("Edit email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows server error when updateOwnerEmail fails", async () => {
    server.use(
      http.patch(
        "http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails/:emailId",
        () => HttpResponse.json({ detail: "Conflict" }, { status: 409 })
      )
    );
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Edit owner1@example.com" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("Remove button calls removeOwnerEmailById", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithNames);
    await user.click(screen.getByRole("button", { name: "Remove owner1@example.com" }));
    await waitFor(() => {
      expect(screen.queryByText("owner1@example.com")).not.toBeInTheDocument();
    });
  });

  it("adds owner with name and email via Add owner form", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("New owner given name"), "Jane");
    await user.type(screen.getByLabelText("New owner surname"), "Smith");
    await user.type(screen.getByLabelText("Add owner email"), "jane@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    await waitFor(() => {
      expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    });
  });

  it("clearing add-owner form after successful add", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("New owner given name"), "Jane");
    await user.type(screen.getByLabelText("Add owner email"), "jane@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Add owner email")).toHaveValue("");
      expect(screen.getByLabelText("New owner given name")).toHaveValue("");
    });
  });

  it("shows validation error when add owner email is empty", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    expect(screen.getByText("Email is required.")).toBeInTheDocument();
  });

  it("renders owner email addresses list with aria-label", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByRole("list", { name: "Owner email addresses" })).toBeInTheDocument();
  });

  // Multi-step sequence test (required by standards)
  it("multi-step: add owner then edit their name", async () => {
    const user = userEvent.setup();
    // Step 1: Add a new owner
    server.use(
      http.post(
        "http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails",
        async ({ request }) => {
          const body = await request.json() as { email?: string; given_name?: string | null; surname?: string | null };
          const updated: LotOwner = {
            ...existingLotOwner,
            owner_emails: [
              ...existingLotOwner.owner_emails,
              { id: "em-bob", email: body?.email ?? "bob@example.com", given_name: body?.given_name ?? null, surname: body?.surname ?? null },
            ],
            emails: [...existingLotOwner.emails, body?.email ?? "bob@example.com"],
          };
          return HttpResponse.json(updated, { status: 201 });
        }
      )
    );
    renderEditForm(existingLotOwner);
    await user.type(screen.getByLabelText("New owner given name"), "Bob");
    await user.type(screen.getByLabelText("Add owner email"), "bob@example.com");
    await user.click(screen.getByRole("button", { name: "Add owner" }));
    // Step 1 done: bob@example.com appears
    await waitFor(() => {
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    });
    // Step 2: Click Edit on the newly added entry and change name
    server.use(
      http.patch(
        "http://localhost/api/admin/lot-owners/:lotOwnerId/owner-emails/:emailId",
        async () => {
          const updated: LotOwner = {
            ...existingLotOwner,
            owner_emails: [
              existingLotOwner.owner_emails[0],
              { id: "em-bob", email: "bob@example.com", given_name: "Robert", surname: null },
            ],
            emails: [...existingLotOwner.emails, "bob@example.com"],
          };
          return HttpResponse.json(updated);
        }
      )
    );
    const editBtn = screen.getByRole("button", { name: "Edit bob@example.com" });
    await user.click(editBtn);
    await user.clear(screen.getByLabelText("Edit given name"));
    await user.type(screen.getByLabelText("Edit given name"), "Robert");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByText("Robert")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Edit modal — phone number field (SMS OTP)
// Phone is now per-contact (per LotOwnerEmail), not per LotOwner.
// ---------------------------------------------------------------------------
describe("LotOwnerForm - Edit modal phone number (per email row)", () => {
  const ownerWithPhone: LotOwner = {
    ...existingLotOwner,
    owner_emails: [
      { id: "em1", email: "owner1@example.com", given_name: "Alice", surname: "Smith", phone_number: "+61400000000" },
    ],
  };

  it("renders phone number field in inline email edit form", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: /Edit owner1@example.com/i }));
    expect(screen.getByLabelText("Edit phone number")).toBeInTheDocument();
  });

  it("edit phone number field has type=tel", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: /Edit owner1@example.com/i }));
    expect(screen.getByLabelText("Edit phone number")).toHaveAttribute("type", "tel");
  });

  it("edit phone number field is empty when email row has no phone", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: /Edit owner1@example.com/i }));
    expect(screen.getByLabelText("Edit phone number")).toHaveValue("");
  });

  it("edit phone number field is pre-populated when email row has a phone", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithPhone);
    await user.click(screen.getByRole("button", { name: /Edit owner1@example.com/i }));
    expect(screen.getByLabelText("Edit phone number")).toHaveValue("+61400000000");
  });

  it("renders phone number in the add-owner phone field", () => {
    renderEditForm(existingLotOwner);
    expect(screen.getByLabelText("New owner phone number")).toBeInTheDocument();
    expect(screen.getByLabelText("New owner phone number")).toHaveAttribute("type", "tel");
  });

  it("displays phone number in email row display view when present", () => {
    renderEditForm(ownerWithPhone);
    expect(screen.getByText("+61400000000")).toBeInTheDocument();
  });

  it("does not display phone number in display view when absent", () => {
    renderEditForm(existingLotOwner);
    // No phone shown — the owner_emails entry has phone_number: null
    expect(screen.queryByText(/\+61/)).not.toBeInTheDocument();
  });

  it("saves email edit with phone number and closes the inline edit form", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    await user.click(screen.getByRole("button", { name: /Edit owner1@example.com/i }));
    const phoneInput = screen.getByLabelText("Edit phone number");
    await user.type(phoneInput, "+61412345678");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // After save the inline edit form should close (editingEmailId reset by mutation onSuccess)
    await waitFor(() => {
      expect(screen.queryByLabelText("Edit phone number")).not.toBeInTheDocument();
    });
  });

  it("resets edit phone field when cancel is clicked", async () => {
    const user = userEvent.setup();
    renderEditForm(ownerWithPhone);
    await user.click(screen.getByRole("button", { name: /Edit owner1@example.com/i }));
    const phoneInput = screen.getByLabelText("Edit phone number");
    expect(phoneInput).toHaveValue("+61400000000");
    // Use getAllByRole because the modal also has a "Cancel" button in the footer
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    await user.click(cancelButtons[0]);
    // After cancel, inline edit is gone
    expect(screen.queryByLabelText("Edit phone number")).not.toBeInTheDocument();
  });

  it("no changes to lot owner fields shows 'No changes detected'", async () => {
    const user = userEvent.setup();
    renderEditForm(existingLotOwner);
    // Submit without any changes to unit entitlement or financial position
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByText("No changes detected.")).toBeInTheDocument();
  });
});
