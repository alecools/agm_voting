import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitSection } from "../SubmitSection";

const noop = () => {};

function renderSection(overrides: Partial<Parameters<typeof SubmitSection>[0]> = {}) {
  const props = {
    unvotedCount: 1,
    isClosed: false,
    showSidebar: false,
    isPending: false,
    onSubmitClick: noop,
    onViewSubmission: noop,
    ...overrides,
  };
  return render(<SubmitSection {...props} />);
}

describe("SubmitSection", () => {
  // --- Happy path ---

  it("renders Submit ballot button when unvotedCount > 0", () => {
    renderSection({ unvotedCount: 1 });
    expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
  });

  it("renders 'all voted' message and View Submission button when unvotedCount === 0 and no sidebar", () => {
    renderSection({ unvotedCount: 0, showSidebar: false });
    expect(screen.getByTestId("all-voted-message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Submission" })).toBeInTheDocument();
  });

  it("calls onSubmitClick when Submit ballot is clicked", async () => {
    const user = userEvent.setup();
    const onSubmitClick = vi.fn();
    renderSection({ unvotedCount: 1, onSubmitClick });
    await user.click(screen.getByRole("button", { name: "Submit ballot" }));
    expect(onSubmitClick).toHaveBeenCalledOnce();
  });

  it("calls onViewSubmission when View Submission is clicked in all-voted state", async () => {
    const user = userEvent.setup();
    const onViewSubmission = vi.fn();
    renderSection({ unvotedCount: 0, showSidebar: false, onViewSubmission });
    await user.click(screen.getByRole("button", { name: "View Submission" }));
    expect(onViewSubmission).toHaveBeenCalledOnce();
  });

  // --- isClosed branch ---

  it("renders nothing when isClosed is true", () => {
    const { container } = renderSection({ isClosed: true });
    expect(container.firstChild).toBeNull();
  });

  // --- showSidebar branch ---

  it("renders nothing when unvotedCount === 0 and showSidebar is true", () => {
    const { container } = renderSection({ unvotedCount: 0, showSidebar: true });
    expect(container.firstChild).toBeNull();
  });

  it("renders Submit ballot button when unvotedCount > 0 and showSidebar is true", () => {
    renderSection({ unvotedCount: 2, showSidebar: true });
    expect(screen.getByRole("button", { name: "Submit ballot" })).toBeInTheDocument();
  });

  it("does NOT render View Submission button alongside Submit ballot (no anySubmitted prop)", () => {
    renderSection({ unvotedCount: 1 });
    expect(screen.queryByRole("button", { name: "View Submission" })).not.toBeInTheDocument();
  });

  // --- isPending branch ---

  it("shows 'Submitting…' text and disables button when isPending is true", () => {
    renderSection({ unvotedCount: 1, isPending: true });
    const btn = screen.getByRole("button", { name: "Submitting…" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-disabled", "true");
  });

  it("button is not disabled when isPending is false", () => {
    renderSection({ unvotedCount: 1, isPending: false });
    const btn = screen.getByRole("button", { name: "Submit ballot" });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute("aria-disabled");
  });

  // --- Boundary values ---

  it("renders nothing when unvotedCount is 0, isClosed is false, and showSidebar is false — all-voted branch entered", () => {
    // Distinct from "renders nothing" — ensure correct branch (all-voted state not null)
    renderSection({ unvotedCount: 0, showSidebar: false });
    expect(screen.getByTestId("all-voted-message")).toBeInTheDocument();
  });

  it("renders nothing (null) when unvotedCount is negative (unexpected boundary)", () => {
    // unvotedCount < 0 falls through to null return
    const { container } = renderSection({ unvotedCount: -1, showSidebar: false });
    expect(container.firstChild).toBeNull();
  });
});
