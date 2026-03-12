import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import BuildingTable from "../BuildingTable";
import type { Building } from "../../../types";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const buildings: Building[] = [
  {
    id: "b1",
    name: "Alpha Tower",
    manager_email: "alpha@example.com",
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "b2",
    name: "Beta Court",
    manager_email: "beta@example.com",
    is_archived: false,
    created_at: "2024-02-01T00:00:00Z",
  },
];

function renderBuildingTable(props: { buildings: Building[] }) {
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
});
