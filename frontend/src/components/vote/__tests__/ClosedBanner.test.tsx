import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClosedBanner } from "../ClosedBanner";

describe("ClosedBanner", () => {
  it("renders closed message", () => {
    render(<ClosedBanner />);
    expect(screen.getByText("Voting has closed for this meeting.")).toBeInTheDocument();
  });

  it("has alert role", () => {
    render(<ClosedBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
