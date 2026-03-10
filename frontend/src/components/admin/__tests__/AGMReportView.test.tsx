import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AGMReportView from "../AGMReportView";
import type { MotionDetail } from "../../../api/admin";

const motions: MotionDetail[] = [
  {
    id: "m1",
    title: "Motion 1",
    description: "First motion description",
    order_index: 0,
    tally: {
      yes: { voter_count: 2, entitlement_sum: 200 },
      no: { voter_count: 1, entitlement_sum: 100 },
      abstained: { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 2, entitlement_sum: 150 },
    },
    voter_lists: {
      yes: [
        { voter_email: "voter1@example.com", entitlement: 100 },
        { voter_email: "voter2@example.com", entitlement: 100 },
      ],
      no: [{ voter_email: "voter3@example.com", entitlement: 100 }],
      abstained: [],
      absent: [
        { voter_email: "voter4@example.com", entitlement: 100 },
        { voter_email: "voter5@example.com", entitlement: 50 },
      ],
    },
  },
  {
    id: "m2",
    title: "Motion 2",
    description: null,
    order_index: 1,
    tally: {
      yes: { voter_count: 1, entitlement_sum: 50 },
      no: { voter_count: 0, entitlement_sum: 0 },
      abstained: { voter_count: 2, entitlement_sum: 200 },
      absent: { voter_count: 0, entitlement_sum: 0 },
    },
    voter_lists: {
      yes: [{ voter_email: "voter1@example.com", entitlement: 50 }],
      no: [],
      abstained: [
        { voter_email: "voter2@example.com", entitlement: 100 },
        { voter_email: "voter3@example.com", entitlement: 100 },
      ],
      absent: [],
    },
  },
];

describe("AGMReportView", () => {
  it("renders motion titles", () => {
    render(<AGMReportView motions={motions} />);
    expect(screen.getByText(/Motion 1/)).toBeInTheDocument();
    expect(screen.getByText(/Motion 2/)).toBeInTheDocument();
  });

  it("renders tally categories for each motion", () => {
    render(<AGMReportView motions={motions} />);
    const yesCells = screen.getAllByText("yes");
    expect(yesCells.length).toBeGreaterThan(0);
    const noCells = screen.getAllByText("no");
    expect(noCells.length).toBeGreaterThan(0);
  });

  it("renders voter counts and entitlement sums", () => {
    render(<AGMReportView motions={motions} />);
    // Yes tally: voter_count=2, entitlement_sum=200
    const cells = screen.getAllByText("2");
    expect(cells.length).toBeGreaterThan(0);
    const entitlementCells = screen.getAllByText("200");
    expect(entitlementCells.length).toBeGreaterThan(0);
  });

  it("renders motion description when present", () => {
    render(<AGMReportView motions={motions} />);
    expect(screen.getByText("First motion description")).toBeInTheDocument();
  });

  it("does not render description when null", () => {
    render(<AGMReportView motions={[motions[1]]} />);
    // Motion 2 has no description
    expect(screen.queryByText("First motion description")).not.toBeInTheDocument();
  });

  it("shows voter lists when expanded", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={motions} />);
    const expandButtons = screen.getAllByRole("button", { name: "Show voter lists" });
    await user.click(expandButtons[0]);
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/voter3@example\.com/)).toBeInTheDocument();
  });

  it("hides voter lists when collapsed", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={motions} />);
    const expandButtons = screen.getAllByRole("button", { name: "Show voter lists" });
    await user.click(expandButtons[0]);
    expect(screen.getByText(/voter1@example\.com/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide voter lists" }));
    expect(screen.queryByText(/voter1@example\.com/)).not.toBeInTheDocument();
  });

  it("shows 'None' for empty voter lists when expanded", async () => {
    const user = userEvent.setup();
    render(<AGMReportView motions={[motions[0]]} />);
    await user.click(screen.getByRole("button", { name: "Show voter lists" }));
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("shows 'No motions' when empty", () => {
    render(<AGMReportView motions={[]} />);
    expect(screen.getByText("No motions.")).toBeInTheDocument();
  });
});
