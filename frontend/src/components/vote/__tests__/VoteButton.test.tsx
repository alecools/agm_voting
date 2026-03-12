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
});
