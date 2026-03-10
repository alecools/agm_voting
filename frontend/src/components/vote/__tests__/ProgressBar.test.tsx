import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "../ProgressBar";

describe("ProgressBar", () => {
  it("shows correct fraction", () => {
    render(<ProgressBar answered={4} total={7} />);
    expect(screen.getByText("4 / 7 motions answered")).toBeInTheDocument();
  });

  it("shows 0/0 when total is zero", () => {
    render(<ProgressBar answered={0} total={0} />);
    expect(screen.getByText("0 / 0 motions answered")).toBeInTheDocument();
  });

  it("shows all answered", () => {
    render(<ProgressBar answered={3} total={3} />);
    expect(screen.getByText("3 / 3 motions answered")).toBeInTheDocument();
  });

  it("has progressbar role with correct values", () => {
    render(<ProgressBar answered={2} total={5} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "5");
  });
});
