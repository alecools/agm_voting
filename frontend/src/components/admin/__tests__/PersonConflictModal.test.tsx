import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PersonConflictModal from "../PersonConflictModal";

function renderModal(
  email = "test@example.com",
  onConfirm = vi.fn(),
  onCancel = vi.fn()
) {
  return render(
    <PersonConflictModal email={email} onConfirm={onConfirm} onCancel={onCancel} />
  );
}

// --- Happy path ---

describe("PersonConflictModal - render", () => {
  it("renders the dialog with role=dialog and aria-modal=true", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("renders the title 'Update person details?'", () => {
    renderModal();
    expect(screen.getByRole("heading", { name: "Update person details?" })).toBeInTheDocument();
  });

  it("renders the email in the body text", () => {
    renderModal("alice@example.com");
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  });

  it("renders 'Update and save' button", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "Update and save" })).toBeInTheDocument();
  });

  it("renders 'Cancel' button", () => {
    renderModal();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("dialog is labelled by the title heading", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-labelledby", "conflict-modal-title");
    expect(document.getElementById("conflict-modal-title")).toHaveTextContent("Update person details?");
  });
});

// --- User interactions ---

describe("PersonConflictModal - interactions", () => {
  it("calls onConfirm when 'Update and save' is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderModal("test@example.com", onConfirm);
    await user.click(screen.getByRole("button", { name: "Update and save" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when 'Cancel' is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderModal("test@example.com", vi.fn(), onCancel);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Escape key is pressed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderModal("test@example.com", vi.fn(), onCancel);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not call onConfirm when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderModal("test@example.com", onConfirm);
    await user.keyboard("{Escape}");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// --- Edge cases ---

describe("PersonConflictModal - edge cases", () => {
  it("removes Escape listener on unmount", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { unmount } = renderModal("test@example.com", vi.fn(), onCancel);
    unmount();
    await user.keyboard("{Escape}");
    // After unmount, handler should be removed — onCancel should not be called
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("body text mentions updating will apply to all lots and proxies", () => {
    renderModal("user@example.com");
    expect(
      screen.getByText(/apply to all lots and proxies linked to this person/i)
    ).toBeInTheDocument();
  });

  it("non-Escape keydown does not call onCancel", async () => {
    // Covers the false branch of `if (e.key === "Escape")` in the event listener
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderModal("test@example.com", vi.fn(), onCancel);
    await user.keyboard("{Enter}");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
