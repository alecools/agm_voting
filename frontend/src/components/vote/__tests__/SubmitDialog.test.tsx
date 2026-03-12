import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitDialog } from "../SubmitDialog";

describe("SubmitDialog", () => {
  it("shows simple confirm dialog when no unanswered motions", () => {
    render(<SubmitDialog unansweredTitles={[]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("Confirm submission")).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure? Votes cannot be changed after submission.")
    ).toBeInTheDocument();
  });

  it("shows unanswered motions dialog when there are unanswered", () => {
    render(
      <SubmitDialog
        unansweredTitles={["Motion A", "Motion B"]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText("Unanswered motions")).toBeInTheDocument();
    expect(screen.getByText("Motion A")).toBeInTheDocument();
    expect(screen.getByText("Motion B")).toBeInTheDocument();
    expect(screen.getByText(/will be recorded as/)).toBeInTheDocument();
  });

  it("calls onConfirm when Submit clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SubmitDialog unansweredTitles={[]} onConfirm={onConfirm} onCancel={() => {}} />
    );
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <SubmitDialog unansweredTitles={[]} onConfirm={() => {}} onCancel={onCancel} />
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("has dialog role", () => {
    render(<SubmitDialog unansweredTitles={[]} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
