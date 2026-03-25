import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitDialog } from "../SubmitDialog";

describe("SubmitDialog", () => {
  it("shows simple confirm dialog when no unanswered motions", () => {
    render(<SubmitDialog unansweredMotions={[]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Confirm submission")).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure? Votes cannot be changed after submission.")
    ).toBeInTheDocument();
  });

  it("shows unanswered motions dialog when there are unanswered", () => {
    render(
      <SubmitDialog
        unansweredMotions={[
          { display_order: 1, title: "Motion A" },
          { display_order: 2, title: "Motion B" },
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
