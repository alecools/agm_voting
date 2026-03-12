import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import GeneralMeetingTable from "../GeneralMeetingTable";
import type { GeneralMeetingListItem } from "../../../api/admin";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const meetings: GeneralMeetingListItem[] = [
  {
    id: "agm1",
    building_id: "b1",
    building_name: "Alpha Tower",
    title: "2024 AGM",
    status: "open",
    meeting_at: "2024-06-01T10:00:00Z",
    voting_closes_at: "2024-06-01T12:00:00Z",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "agm2",
    building_id: "b2",
    building_name: "Beta Court",
    title: "2023 AGM",
    status: "closed",
    meeting_at: "2023-06-01T10:00:00Z",
    voting_closes_at: "2023-06-01T12:00:00Z",
    created_at: "2023-01-01T00:00:00Z",
  },
];

function renderTable(props: { meetings: GeneralMeetingListItem[] }) {
  return render(
    <MemoryRouter>
      <GeneralMeetingTable {...props} />
    </MemoryRouter>
  );
}

describe("GeneralMeetingTable", () => {
  it("renders meeting titles and building names", () => {
    renderTable({ meetings });
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    expect(screen.getByText("Beta Court")).toBeInTheDocument();
  });

  it("renders Open badge for open meeting", () => {
    renderTable({ meetings });
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("renders Closed badge for closed meeting", () => {
    renderTable({ meetings });
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("navigates to meeting detail on row click", async () => {
    const user = userEvent.setup();
    renderTable({ meetings });
    await user.click(screen.getByText("2024 AGM"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings/agm1");
  });

  it("shows empty message when no meetings", () => {
    renderTable({ meetings: [] });
    expect(screen.getByText("No General Meetings found.")).toBeInTheDocument();
  });

  it("renders table headers", () => {
    renderTable({ meetings });
    expect(screen.getByText("Building")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Meeting At")).toBeInTheDocument();
    expect(screen.getByText("Voting Closes At")).toBeInTheDocument();
  });
});
