import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GeneralMeetingListItem } from "../GeneralMeetingListItem";

const openMeeting = {
  id: "agm-1",
  title: "2024 AGM",
  status: "open" as const,
  meeting_at: "2024-06-01T10:00:00Z",
  voting_closes_at: "2024-06-01T12:00:00Z",
};

const closedMeeting = {
  id: "agm-2",
  title: "2023 AGM",
  status: "closed" as const,
  meeting_at: "2023-06-01T10:00:00Z",
  voting_closes_at: "2023-06-01T12:00:00Z",
};

const pendingMeeting = {
  id: "agm-3",
  title: "2025 AGM",
  status: "pending" as const,
  meeting_at: "2025-12-01T10:00:00Z",
  voting_closes_at: "2025-12-31T12:00:00Z",
};

describe("GeneralMeetingListItem", () => {
  it("renders meeting title", () => {
    render(
      <GeneralMeetingListItem meeting={openMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
  });

  it("renders Open status badge for open meeting", () => {
    render(
      <GeneralMeetingListItem meeting={openMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Open");
  });

  it("renders Closed status badge for closed meeting", () => {
    render(
      <GeneralMeetingListItem meeting={closedMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Closed");
  });

  it("renders Pending status badge for pending meeting", () => {
    render(
      <GeneralMeetingListItem meeting={pendingMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Pending");
  });

  it("shows Enter Voting button for open meeting", () => {
    render(
      <GeneralMeetingListItem meeting={openMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByRole("button", { name: "Enter Voting" })).toBeInTheDocument();
  });

  it("shows View My Submission button for closed meeting", () => {
    render(
      <GeneralMeetingListItem meeting={closedMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByRole("button", { name: "View My Submission" })).toBeInTheDocument();
  });

  it("shows disabled Voting Not Yet Open button for pending meeting", () => {
    render(
      <GeneralMeetingListItem meeting={pendingMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    const btn = screen.getByRole("button", { name: "Voting Not Yet Open" });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("calls onEnterVoting with meeting id when Enter Voting clicked", async () => {
    const user = userEvent.setup();
    const onEnterVoting = vi.fn();
    render(
      <GeneralMeetingListItem meeting={openMeeting} onEnterVoting={onEnterVoting} onViewSubmission={() => {}} />
    );
    await user.click(screen.getByRole("button", { name: "Enter Voting" }));
    expect(onEnterVoting).toHaveBeenCalledWith("agm-1");
  });

  it("calls onViewSubmission with meeting id when View My Submission clicked", async () => {
    const user = userEvent.setup();
    const onViewSubmission = vi.fn();
    render(
      <GeneralMeetingListItem meeting={closedMeeting} onEnterVoting={() => {}} onViewSubmission={onViewSubmission} />
    );
    await user.click(screen.getByRole("button", { name: "View My Submission" }));
    expect(onViewSubmission).toHaveBeenCalledWith("agm-2");
  });

  it("displays meeting and voting close times", () => {
    render(
      <GeneralMeetingListItem meeting={openMeeting} onEnterVoting={() => {}} onViewSubmission={() => {}} />
    );
    expect(screen.getByText(/Meeting:/)).toBeInTheDocument();
    expect(screen.getByText(/Voting closes:/)).toBeInTheDocument();
  });
});
