import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import GeneralMeetingTable from "../GeneralMeetingTable";
import type { GeneralMeetingListItem } from "../../../api/admin";
import type { SortDir } from "../SortableColumnHeader";
import { ADMIN_MEETING_LIST } from "../../../../tests/msw/handlers";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Use the open + closed entries from the shared MSW fixture (first two items).
const meetings: GeneralMeetingListItem[] = ADMIN_MEETING_LIST.slice(0, 2);

function makeMeetings(count: number): GeneralMeetingListItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agm${i + 1}`,
    building_id: "b1",
    building_name: "Alpha Tower",
    title: `Meeting ${i + 1}`,
    status: "open" as const,
    meeting_at: "2024-06-01T10:00:00Z",
    voting_closes_at: "2024-06-01T12:00:00Z",
    created_at: "2024-01-01T00:00:00Z",
  }));
}

function renderTable(props: {
  meetings: GeneralMeetingListItem[];
  isLoading?: boolean;
  sortBy?: string;
  sortDir?: SortDir;
  onSort?: (col: string) => void;
}) {
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

  it("shows loading row in table body when isLoading and no data yet", () => {
    renderTable({ meetings: [], isLoading: true });
    expect(screen.getByText("Loading General Meetings...")).toBeInTheDocument();
    expect(screen.queryByText("No General Meetings found.")).not.toBeInTheDocument();
  });

  it("does not show loading row when isLoading but data is already present", () => {
    renderTable({ meetings, isLoading: true });
    expect(screen.queryByText("Loading General Meetings...")).not.toBeInTheDocument();
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
  });

  it("renders static table headers when no onSort prop provided", () => {
    renderTable({ meetings });
    expect(screen.getByText("Building")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Meeting At")).toBeInTheDocument();
    expect(screen.getByText("Voting Closes At")).toBeInTheDocument();
    expect(screen.getByText("Created At")).toBeInTheDocument();
  });

  // --- Sort props ---

  it("renders all sortable column headers when onSort is provided", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    expect(screen.getByRole("button", { name: /Building/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Meeting At/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voting Closes At/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Created At/ })).toBeInTheDocument();
  });

  it("calls onSort with 'title' when Title header button is clicked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    await user.click(screen.getByRole("button", { name: /Title/ }));
    expect(onSort).toHaveBeenCalledWith("title");
  });

  it("calls onSort with 'status' when Status header button is clicked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    await user.click(screen.getByRole("button", { name: /Status/ }));
    expect(onSort).toHaveBeenCalledWith("status");
  });

  it("calls onSort with 'meeting_at' when Meeting At header button is clicked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    await user.click(screen.getByRole("button", { name: /Meeting At/ }));
    expect(onSort).toHaveBeenCalledWith("meeting_at");
  });

  it("calls onSort with 'voting_closes_at' when Voting Closes At header button is clicked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    await user.click(screen.getByRole("button", { name: /Voting Closes At/ }));
    expect(onSort).toHaveBeenCalledWith("voting_closes_at");
  });

  it("calls onSort with 'created_at' when Created At header button is clicked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "title", sortDir: "asc", onSort });
    await user.click(screen.getByRole("button", { name: /Created At/ }));
    expect(onSort).toHaveBeenCalledWith("created_at");
  });

  it("shows ▲ on active title column when sortDir is asc", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "title", sortDir: "asc", onSort });
    const titleBtn = screen.getByRole("button", { name: /Title/ });
    expect(titleBtn.textContent).toContain("▲");
  });

  it("shows ▼ on active created_at column when sortDir is desc", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    const createdBtn = screen.getByRole("button", { name: /Created At/ });
    expect(createdBtn.textContent).toContain("▼");
  });

  it("shows ▼ on active status column when sortDir is desc", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "status", sortDir: "desc", onSort });
    const statusBtn = screen.getByRole("button", { name: /Status/ });
    expect(statusBtn.textContent).toContain("▼");
  });

  it("shows ▲ on active meeting_at column when sortDir is asc", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "meeting_at", sortDir: "asc", onSort });
    const meetingAtBtn = screen.getByRole("button", { name: /Meeting At/ });
    expect(meetingAtBtn.textContent).toContain("▲");
  });

  it("shows ▲ on active voting_closes_at column when sortDir is asc", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "voting_closes_at", sortDir: "asc", onSort });
    const votingBtn = screen.getByRole("button", { name: /Voting Closes At/ });
    expect(votingBtn.textContent).toContain("▲");
  });

  it("shows ⇅ on inactive columns", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    // Title is inactive so should show ⇅
    const titleBtn = screen.getByRole("button", { name: /Title/ });
    expect(titleBtn.textContent).toContain("⇅");
  });

  it("active Created At th has aria-sort='descending'", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    const createdBtn = screen.getByRole("button", { name: /Created At/ });
    const th = createdBtn.closest("th");
    expect(th).toHaveAttribute("aria-sort", "descending");
  });

  it("inactive Title th has aria-sort='none'", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    const titleBtn = screen.getByRole("button", { name: /Title/ });
    const th = titleBtn.closest("th");
    expect(th).toHaveAttribute("aria-sort", "none");
  });

  it("Building column is sortable when onSort is provided", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    expect(screen.getByRole("button", { name: /Building/ })).toBeInTheDocument();
  });

  it("calls onSort with 'building_name' when Building header button is clicked", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "created_at", sortDir: "desc", onSort });
    await user.click(screen.getByRole("button", { name: /Building/ }));
    expect(onSort).toHaveBeenCalledWith("building_name");
  });

  it("Building column shows aria-sort='ascending' when sortBy='building_name' and sortDir='asc'", () => {
    const onSort = vi.fn();
    renderTable({ meetings, sortBy: "building_name", sortDir: "asc", onSort });
    const btn = screen.getByRole("button", { name: /Building/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("Building column is a plain th (no sort button) when no onSort prop provided", () => {
    renderTable({ meetings });
    expect(screen.queryByRole("button", { name: /Building/ })).not.toBeInTheDocument();
    expect(screen.getByText("Building")).toBeInTheDocument();
  });

  // --- Pagination ---

  it("does not show pagination controls when there are 20 or fewer meetings", () => {
    renderTable({ meetings: makeMeetings(20) });
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows pagination controls at both top and bottom when there are more than 20 meetings", () => {
    renderTable({ meetings: makeMeetings(21) });
    const prevButtons = screen.getAllByRole("button", { name: "Previous page" });
    const nextButtons = screen.getAllByRole("button", { name: "Next page" });
    expect(prevButtons).toHaveLength(2);
    expect(nextButtons).toHaveLength(2);
  });

  it("renders only the first 20 rows on page 1 of a 21-item list", () => {
    renderTable({ meetings: makeMeetings(21) });
    const tbody = screen.getByRole("table").querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows).toHaveLength(20);
    expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    expect(screen.getByText("Meeting 20")).toBeInTheDocument();
    expect(screen.queryByText("Meeting 21")).not.toBeInTheDocument();
  });

  it("navigating to page 2 shows row 21", async () => {
    const user = userEvent.setup();
    renderTable({ meetings: makeMeetings(21) });
    // Use the first (top) Next page button
    await user.click(screen.getAllByRole("button", { name: "Next page" })[0]);
    expect(screen.getByText("Meeting 21")).toBeInTheDocument();
    expect(screen.queryByText("Meeting 1")).not.toBeInTheDocument();
  });

  it("page resets to 1 when sort changes (page state managed externally, sort button resets page via onSort)", async () => {
    // The table itself no longer does internal page reset on meetings.length change
    // Sort-triggered page reset is handled by the parent (GeneralMeetingListPage).
    // This test verifies the table renders stably when meetings prop changes.
    const user = userEvent.setup();
    const onSort = vi.fn();
    const { rerender } = renderTable({ meetings: makeMeetings(21), sortBy: "created_at", sortDir: "desc", onSort });
    // Navigate to page 2 via top Next page button
    await user.click(screen.getAllByRole("button", { name: "Next page" })[0]);
    expect(screen.getByText("Meeting 21")).toBeInTheDocument();
    // Rerender with a smaller list — the component internal page may stay at 2 but safePage clamps to totalPages
    rerender(
      <MemoryRouter>
        <GeneralMeetingTable meetings={makeMeetings(5)} sortBy="created_at" sortDir="desc" onSort={onSort} />
      </MemoryRouter>
    );
    expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
  });
});
