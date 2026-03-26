import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MotionEditor from "../MotionEditor";
import type { MotionFormEntry } from "../MotionEditor";

const initialMotions: MotionFormEntry[] = [
  { title: "Motion 1", description: "Desc 1", motion_number: "", motion_type: "general" },
  { title: "Motion 2", description: "", motion_number: "SR-1", motion_type: "special" },
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
    expect(screen.getByRole("button", { name: "+ Add Motion" })).toBeInTheDocument();
  });

  it("calls onChange with new motion when Add Motion clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "+ Add Motion" }));
    expect(onChange).toHaveBeenCalledWith([
      ...initialMotions,
      { title: "", description: "", motion_number: "", motion_type: "general" },
    ]);
  });

  it("calls onChange without the removed motion when Remove clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([initialMotions[1]]);
  });

  it("calls onChange with updated title when title input changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const titleInputs = screen.getAllByLabelText("Title");
    await user.type(titleInputs[0], "X");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].title).toBe("Motion 1X");
  });

  it("calls onChange with updated description when textarea changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const descTextareas = screen.getAllByLabelText("Description");
    await user.type(descTextareas[0], "X");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].description).toBe("Desc 1X");
  });

  it("renders motion index headers", () => {
    render(<MotionEditor motions={initialMotions} onChange={() => {}} />);
    expect(screen.getByText("Motion 1")).toBeInTheDocument();
    expect(screen.getByText("Motion 2")).toBeInTheDocument();
  });

  it("renders Motion Type dropdown with correct default value", () => {
    render(<MotionEditor motions={initialMotions} onChange={() => {}} />);
    const selects = screen.getAllByLabelText("Motion Type") as HTMLSelectElement[];
    expect(selects[0].value).toBe("general");
    expect(selects[1].value).toBe("special");
  });

  it("calls onChange with updated motion_type when dropdown changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const selects = screen.getAllByLabelText("Motion Type");
    await user.selectOptions(selects[0], "special");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].motion_type).toBe("special");
  });

  it("renders motion number input with correct initial value", () => {
    render(<MotionEditor motions={initialMotions} onChange={() => {}} />);
    const inputs = screen.getAllByLabelText("Motion number (optional)") as HTMLInputElement[];
    expect(inputs[0].value).toBe("");
    expect(inputs[1].value).toBe("SR-1");
  });

  it("calls onChange with updated motion_number when motion number input changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MotionEditor motions={initialMotions} onChange={onChange} />);
    const inputs = screen.getAllByLabelText("Motion number (optional)");
    await user.type(inputs[0], "1");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].motion_number).toBe("1");
  });
});
