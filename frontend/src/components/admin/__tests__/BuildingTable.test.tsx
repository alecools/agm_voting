import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import BuildingTable from "../BuildingTable";
import type { Building } from "../../../types";
import { ADMIN_BUILDINGS } from "../../../../tests/msw/handlers";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Use the first two active (non-archived) buildings from the shared MSW fixture.
const buildings: Building[] = ADMIN_BUILDINGS.filter((b) => !b.is_archived);

function renderBuildingTable(props: { buildings: Building[]; isLoading?: boolean }) {
  return render(
    <MemoryRouter>
      <BuildingTable {...props} />
    </MemoryRouter>
  );
}

describe("BuildingTable", () => {
  it("renders building names and emails", () => {
    renderBuildingTable({ buildings });
    expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    expect(screen.getByText("alpha@example.com")).toBeInTheDocument();
    expect(screen.getByText("Beta Court")).toBeInTheDocument();
    expect(screen.getByText("beta@example.com")).toBeInTheDocument();
  });

  it("shows empty message when no buildings", () => {
    renderBuildingTable({ buildings: [] });
    expect(screen.getByText("No buildings found.")).toBeInTheDocument();
  });

  it("shows loading row in table body when isLoading and no data yet", () => {
    renderBuildingTable({ buildings: [], isLoading: true });
    expect(screen.getByText("Loading buildings...")).toBeInTheDocument();
    expect(screen.queryByText("No buildings found.")).not.toBeInTheDocument();
  });

  it("does not show loading row when isLoading but data is already present", () => {
    renderBuildingTable({ buildings, isLoading: true });
    expect(screen.queryByText("Loading buildings...")).not.toBeInTheDocument();
    expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
  });

  it("navigates to building detail on name click", async () => {
    const user = userEvent.setup();
    renderBuildingTable({ buildings });
    await user.click(screen.getByRole("button", { name: "Alpha Tower" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/buildings/b1");
  });

  it("renders table headers", () => {
    renderBuildingTable({ buildings });
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Manager Email")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Created At")).toBeInTheDocument();
  });

  it("shows Archived badge for archived buildings", () => {
    const archivedBuildings: Building[] = [
      {
        id: "b3",
        name: "Old Tower",
        manager_email: "old@example.com",
        is_archived: true,
        created_at: "2023-01-01T00:00:00Z",
      },
    ];
    renderBuildingTable({ buildings: archivedBuildings });
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("does not show Archived badge for active buildings", () => {
    renderBuildingTable({ buildings });
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  it("resets to page 1 when buildings list length changes", async () => {
    const user = userEvent.setup();
    // Build 21 buildings so page 2 exists (PAGE_SIZE = 20)
    const manyBuildings: Building[] = Array.from({ length: 21 }, (_, i) => ({
      id: `b${i + 1}`,
      name: `Building ${i + 1}`,
      manager_email: `mgr${i + 1}@example.com`,
      is_archived: false,
      created_at: "2024-01-01T00:00:00Z",
    }));

    const { rerender } = render(
      <MemoryRouter>
        <BuildingTable buildings={manyBuildings} />
      </MemoryRouter>
    );

    // Navigate to page 2 via the first (top) page-2 button
    await user.click(screen.getAllByRole("button", { name: "2" })[0]);
    // Confirm we're on page 2 (Building 21 is visible, Building 1 is not)
    expect(screen.getByText("Building 21")).toBeInTheDocument();
    expect(screen.queryByText("Building 1")).not.toBeInTheDocument();

    // Re-render with a shorter list (only 1 page worth)
    const fewBuildings: Building[] = manyBuildings.slice(0, 5);
    rerender(
      <MemoryRouter>
        <BuildingTable buildings={fewBuildings} />
      </MemoryRouter>
    );

    // Page should have reset to 1 — Building 1 is now visible
    expect(screen.getByText("Building 1")).toBeInTheDocument();
    // Pagination controls should be gone (only 1 page)
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
  });

  // --- Pagination top + bottom ---

  it("does not show pagination controls when buildings fit on one page", () => {
    renderBuildingTable({ buildings });
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows pagination controls at both top and bottom when there are more than 20 buildings", () => {
    const manyBuildings: Building[] = Array.from({ length: 21 }, (_, i) => ({
      id: `b${i + 1}`,
      name: `Building ${i + 1}`,
      manager_email: `mgr${i + 1}@example.com`,
      is_archived: false,
      created_at: "2024-01-01T00:00:00Z",
    }));
    renderBuildingTable({ buildings: manyBuildings });
    const prevButtons = screen.getAllByRole("button", { name: "Previous page" });
    const nextButtons = screen.getAllByRole("button", { name: "Next page" });
    expect(prevButtons).toHaveLength(2);
    expect(nextButtons).toHaveLength(2);
  });
});
