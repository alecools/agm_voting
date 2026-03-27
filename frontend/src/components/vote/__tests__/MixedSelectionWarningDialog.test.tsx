import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MixedSelectionWarningDialog } from "../MixedSelectionWarningDialog";
import type { LotInfo } from "../../../api/voter";

const makeLot = (lot_number: string, voted_motion_ids: string[] = []): LotInfo => ({
  lot_owner_id: `lo-${lot_number}`,
  lot_number,
  financial_position: "normal",
  already_submitted: false,
  is_proxy: false,
  voted_motion_ids,
});

describe("MixedSelectionWarningDialog", () => {
  // --- Happy path ---

  it("renders the warning title", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1", ["m1"]), makeLot("2")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Mixed voting history" })).toBeInTheDocument();
  });

  it("renders the warning message about prior votes not changing", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1", ["m1"])]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByText(/previously submitted votes will not be changed/)).toBeInTheDocument();
  });

  it("renders lot numbers for differing lots", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("3", ["m1"]), makeLot("7")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByText("Lot 3")).toBeInTheDocument();
    expect(screen.getByText("Lot 7")).toBeInTheDocument();
  });

  it("renders Continue button", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("renders Go back button", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Go back to lot selection" })).toBeInTheDocument();
  });

  it("has dialog role", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // --- User interaction ---

  it("calls onContinue when Continue clicked", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1", ["m1"])]}
        onContinue={onContinue}
        onGoBack={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("calls onGoBack when Go back clicked", async () => {
    const user = userEvent.setup();
    const onGoBack = vi.fn();
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1", ["m1"])]}
        onContinue={() => {}}
        onGoBack={onGoBack}
      />
    );
    await user.click(screen.getByRole("button", { name: "Go back to lot selection" }));
    expect(onGoBack).toHaveBeenCalledOnce();
  });

  // --- US-ACC-02: Focus trap ---

  it("focuses first button on mount", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Go back to lot selection" })).toHaveFocus();
  });

  it("wraps Tab focus from last to first button", async () => {
    const user = userEvent.setup();
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    const goBackBtn = screen.getByRole("button", { name: "Go back to lot selection" });
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    continueBtn.focus();
    await user.tab();
    expect(goBackBtn).toHaveFocus();
  });

  it("wraps Shift+Tab focus from first to last button", async () => {
    const user = userEvent.setup();
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    const goBackBtn = screen.getByRole("button", { name: "Go back to lot selection" });
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    goBackBtn.focus();
    await user.tab({ shift: true });
    expect(continueBtn).toHaveFocus();
  });

  // --- Edge cases ---

  it("renders with empty differingLots without crashing", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    // No lot list items rendered (list items render as "Lot N"; body text says "Lots" not "Lot N")
    expect(screen.queryByText(/^Lot \d/)).not.toBeInTheDocument();
    // Dialog still renders correctly
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders the 'Do you want to continue?' prompt", () => {
    render(
      <MixedSelectionWarningDialog
        differingLots={[makeLot("1")]}
        onContinue={() => {}}
        onGoBack={() => {}}
      />
    );
    expect(screen.getByText("Do you want to continue?")).toBeInTheDocument();
  });
});
