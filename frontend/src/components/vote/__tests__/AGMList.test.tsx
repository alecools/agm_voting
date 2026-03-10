import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AGMList } from "../AGMList";

const agms = [
  {
    id: "agm-1",
    title: "2024 AGM",
    status: "open" as const,
    meeting_at: "2024-06-01T10:00:00Z",
    voting_closes_at: "2024-06-01T12:00:00Z",
  },
  {
    id: "agm-2",
    title: "2023 AGM",
    status: "closed" as const,
    meeting_at: "2023-06-01T10:00:00Z",
    voting_closes_at: "2023-06-01T12:00:00Z",
  },
];

describe("AGMList", () => {
  it("renders all AGM items", () => {
    render(<AGMList agms={agms} onEnterVoting={() => {}} onViewSubmission={() => {}} />);
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
  });

  it("shows empty message when no agms", () => {
    render(<AGMList agms={[]} onEnterVoting={() => {}} onViewSubmission={() => {}} />);
    expect(screen.getByText("No AGMs found for this building.")).toBeInTheDocument();
  });
});
