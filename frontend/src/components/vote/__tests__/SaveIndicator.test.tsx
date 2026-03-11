import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SaveIndicator } from "../SaveIndicator";

describe("SaveIndicator", () => {
  it("renders nothing when status is idle", () => {
    const { container } = render(<SaveIndicator status="idle" onSave={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Saving... when status is saving", () => {
    render(<SaveIndicator status="saving" onSave={() => {}} />);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("shows Saved when status is saved", () => {
    render(<SaveIndicator status="saved" onSave={() => {}} />);
    expect(screen.getByText(/Saved/)).toBeInTheDocument();
  });

  it("shows error message and Retry button when status is error", () => {
    render(<SaveIndicator status="error" onSave={() => {}} />);
    expect(screen.getByText(/Could not save\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("calls onSave when Retry button clicked in error state", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SaveIndicator status="error" onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onSave).toHaveBeenCalledOnce();
  });
});
