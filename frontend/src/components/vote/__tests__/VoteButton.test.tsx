import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoteButton } from "../VoteButton";

describe("VoteButton", () => {
  it("renders Yes label", () => {
    render(<VoteButton choice="yes" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "For" })).toBeInTheDocument();
  });

  it("renders No label", () => {
    render(<VoteButton choice="no" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Against" })).toBeInTheDocument();
  });

  it("renders Abstain label", () => {
    render(<VoteButton choice="abstained" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Abstain" })).toBeInTheDocument();
  });

  it("has aria-pressed=true when selected", () => {
    render(<VoteButton choice="yes" selected={true} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "For" })).toHaveAttribute("aria-pressed", "true");
  });

  it("has aria-pressed=false when not selected", () => {
    render(<VoteButton choice="yes" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "For" })).toHaveAttribute("aria-pressed", "false");
  });

  it("is disabled when disabled prop is true", () => {
    render(<VoteButton choice="yes" selected={false} disabled={true} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "For" })).toBeDisabled();
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<VoteButton choice="yes" selected={false} disabled={false} onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "For" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not call onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<VoteButton choice="yes" selected={false} disabled={true} onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "For" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  // --- RR3-25: VoteButton accessible name ---

  it("yes button has accessible name 'For' independent of icon", () => {
    render(<VoteButton choice="yes" selected={false} disabled={false} onClick={() => {}} />);
    // accessible name is derived from the visible text label, not the icon
    expect(screen.getByRole("button", { name: "For" })).toBeInTheDocument();
  });

  it("no button has accessible name 'Against'", () => {
    render(<VoteButton choice="no" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Against" })).toBeInTheDocument();
  });

  it("abstained button has accessible name 'Abstain'", () => {
    render(<VoteButton choice="abstained" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Abstain" })).toBeInTheDocument();
  });

  it("not_eligible button has accessible name 'Not Eligible'", () => {
    render(<VoteButton choice="not_eligible" selected={false} disabled={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Not Eligible" })).toBeInTheDocument();
  });

  // --- ACCESSIBILITY-2: optional ariaLabel prop ---

  it("uses ariaLabel as accessible name when provided", () => {
    render(
      <VoteButton
        choice="yes"
        selected={false}
        disabled={false}
        ariaLabel="Vote For for Motion 1"
        onClick={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Vote For for Motion 1" })).toBeInTheDocument();
  });

  it("does not set aria-label attribute when ariaLabel prop is omitted", () => {
    render(<VoteButton choice="yes" selected={false} disabled={false} onClick={() => {}} />);
    const btn = screen.getByRole("button", { name: "For" });
    expect(btn).not.toHaveAttribute("aria-label");
  });
});
