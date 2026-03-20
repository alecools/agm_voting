import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AGMReportView from "../AGMReportView";
import type { MotionDetail } from "../../../api/admin";

const motions: MotionDetail[] = [
  {
    id: "m1",
    title: "Motion 1",
    description: "First motion description",
    order_index: 0,
    motion_type: "general" as const,
    is_visible: true,
    tally: {
      yes: { voter_count: 2, entitlement_sum: 200 },
      no: { voter_count: 1, entitlement_sum: 100 },
      abstained: { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 2, entitlement_sum: 150 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
    },
    voter_lists: {
      yes: [
        { voter_email: "voter1@example.com", lot_number: "L1", entitlement: 100 },
        { voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 },
      ],
      no: [{ voter_email: "voter3@example.com", lot_number: "L3", entitlement: 100 }],
      abstained: [],
      absent: [
        { voter_email: "voter4@example.com", lot_number: "L4", entitlement: 100 },
        { voter_email: "voter5@example.com", lot_number: "L5", entitlement: 50 },
      ],
      not_eligible: [],
    },
  },
  {
    id: "m2",
    title: "Motion 2",
    description: null,
    order_index: 1,
    motion_type: "special" as const,
    is_visible: true,
    tally: {
      yes: { voter_count: 1, entitlement_sum: 50 },
      no: { voter_count: 0, entitlement_sum: 0 },
      abstained: { voter_count: 2, entitlement_sum: 200 },
      absent: { voter_count: 0, entitlement_sum: 0 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
    },
    voter_lists: {
      yes: [{ voter_email: "voter1@example.com", lot_number: "L1", entitlement: 50 }],
      no: [],
      abstained: [
        { voter_email: "voter2@example.com", lot_number: "L2", entitlement: 100 },
        { voter_email: "voter3@example.com", lot_number: "L3", entitlement: 100 },
      ],
      absent: [],
      not_eligible: [],
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
    const forCells = screen.getAllByText("For");
    expect(forCells.length).toBeGreaterThan(0);
    const againstCells = screen.getAllByText("Against");
    expect(againstCells.length).toBeGreaterThan(0);
  });

  it("renders voter counts", () => {
    render(<AGMReportView motions={motions} totalEntitlement={1000} />);
    // Yes tally for motion 1: voter_count=2
    const cells = screen.getAllByText("2");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("shows entitlement sum with percentage when totalEntitlement > 0", () => {
    // Motion 1 yes: entitlement_sum=200, total=1000 → 20.0%
    render(<AGMReportView motions={[motions[0]]} totalEntitlement={1000} />);
    expect(screen.getByText("200 (20.0%)")).toBeInTheDocument();
  });

  it("shows entitlement sum with percentage rounded to 1 decimal", () => {
    // Motion 1 no: entitlement_sum=100, total=300 → 33.3%
    render(<AGMReportView motions={[motions[0]]} totalEntitlement={300} />);
    expect(screen.getByText("100 (33.3%)")).toBeInTheDocument();
  });

  it("shows — for entitlement when totalEntitlement is 0", () => {
    render(<AGMReportView motions={[motions[0]]} totalEntitlement={0} />);
    // All categories should show — for entitlement
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("shows — when totalEntitlement prop is omitted (defaults to 0)", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
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

  it("shows General badge for general motion", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    const badge = screen.getByLabelText("Motion type: General");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--general");
  });

  it("shows Special badge for special motion", () => {
    render(<AGMReportView motions={[motions[1]]} />);
    const badge = screen.getByLabelText("Motion type: Special");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--special");
  });

  it("renders export CSV button", () => {
    render(<AGMReportView motions={motions} />);
    expect(screen.getByRole("button", { name: /Export voter lists/ })).toBeInTheDocument();
  });

  it("shows 'No motions recorded' when empty", () => {
    render(<AGMReportView motions={[]} />);
    expect(screen.getByText("No motions recorded.")).toBeInTheDocument();
  });

  it("shows Hidden badge for motion with is_visible=false", () => {
    const hiddenMotion: MotionDetail = {
      ...motions[0],
      id: "m-hidden",
      is_visible: false,
    };
    render(<AGMReportView motions={[hiddenMotion]} />);
    const badge = screen.getByLabelText("Motion is hidden from voters");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("motion-type-badge--hidden");
  });

  it("does not show Hidden badge for visible motion", () => {
    render(<AGMReportView motions={[motions[0]]} />);
    expect(screen.queryByLabelText("Motion is hidden from voters")).not.toBeInTheDocument();
  });
});
