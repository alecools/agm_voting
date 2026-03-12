import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GeneralMeetingList } from "../GeneralMeetingList";

const meetings = [
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

describe("GeneralMeetingList", () => {
  it("renders all meeting items", () => {
    render(<GeneralMeetingList meetings={meetings} onEnterVoting={() => {}} onViewSubmission={() => {}} />);
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
  });

  it("shows empty message when no meetings", () => {
    render(<GeneralMeetingList meetings={[]} onEnterVoting={() => {}} onViewSubmission={() => {}} />);
    expect(screen.getByText("No General Meetings found for this building.")).toBeInTheDocument();
  });
});
