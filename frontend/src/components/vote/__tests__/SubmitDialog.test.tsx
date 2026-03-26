import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitDialog } from "../SubmitDialog";

describe("SubmitDialog", () => {
  // --- Happy path ---

  it("shows simple confirm dialog when no unanswered motions", () => {
    render(<SubmitDialog unansweredMotions={[]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Confirm submission")).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure? Votes cannot be changed after submission.")
    ).toBeInTheDocument();
  });

  it("shows unanswered motions dialog using display_order when motion_number is null", () => {
    render(
      <SubmitDialog
        unansweredMotions={[
          { display_order: 1, motion_number: null, title: "Motion A" },
          { display_order: 2, motion_number: null, title: "Motion B" },
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText("Unanswered motions")).toBeInTheDocument();
    expect(screen.getByText("Motion 1 — Motion A")).toBeInTheDocument();
    expect(screen.getByText("Motion 2 — Motion B")).toBeInTheDocument();
    expect(screen.getByText(/will be recorded as/)).toBeInTheDocument();
  });

  it("shows unanswered motions dialog using motion_number when set", () => {
    render(
      <SubmitDialog
        unansweredMotions={[
          { display_order: 1, motion_number: "A1", title: "Motion A" },
          { display_order: 2, motion_number: "  BBB  ", title: "Motion B" },
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText("Motion A1 — Motion A")).toBeInTheDocument();
    expect(screen.getByText("Motion BBB — Motion B")).toBeInTheDocument();
  });

  it("falls back to display_order when motion_number is empty string", () => {
    render(
      <SubmitDialog
        unansweredMotions={[
          { display_order: 3, motion_number: "   ", title: "Motion C" },
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText("Motion 3 — Motion C")).toBeInTheDocument();
  });

  it("calls onConfirm when Submit clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SubmitDialog unansweredMotions={[]} onConfirm={onConfirm} onCancel={() => {}} />
    );
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <SubmitDialog unansweredMotions={[]} onConfirm={() => {}} onCancel={onCancel} />
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("has dialog role", () => {
    render(<SubmitDialog unansweredMotions={[]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
