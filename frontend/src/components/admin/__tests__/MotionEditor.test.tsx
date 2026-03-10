import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MotionEditor from "../MotionEditor";
import type { MotionFormEntry } from "../MotionEditor";

const initialMotions: MotionFormEntry[] = [
  { title: "Motion 1", description: "Desc 1" },
  { title: "Motion 2", description: "" },
];

describe("MotionEditor", () => {
  it("renders existing motions", () => {
    render(<MotionEditor motions={initialMotions} onChange={() => {}} />);
    expect(screen.getByDisplayValue("Motion 1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Desc 1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Motion 2")).toBeInTheDocument();
  });

  it("shows Add Motion button", () => {
    render(<MotionEditor motions={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Add Motion" })).toBeInTheDocument();
  });

  it("calls onChange with new motion when Add Motion clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Add Motion" }));
    expect(onChange).toHaveBeenCalledWith([
      ...initialMotions,
      { title: "", description: "" },
    ]);
  });

  it("calls onChange without the removed motion when Remove clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const removeButtons = screen.getAllByRole("button", { name: "Remove Motion" });
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([initialMotions[1]]);
  });

  it("calls onChange with updated title when title input changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const titleInput = screen.getByLabelText("Motion 1 Title");
    await user.type(titleInput, "X");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].title).toBe("Motion 1X");
  });

  it("calls onChange with updated description when textarea changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const descTextarea = screen.getByLabelText("Motion 1 Description");
    await user.type(descTextarea, "X");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].description).toBe("Desc 1X");
  });

  it("renders motion index labels", () => {
    render(<MotionEditor motions={initialMotions} onChange={() => {}} />);
    expect(screen.getByText("Motion 1 Title")).toBeInTheDocument();
    expect(screen.getByText("Motion 2 Title")).toBeInTheDocument();
  });
});
