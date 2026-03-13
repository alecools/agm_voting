import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LotOwnerTable from "../LotOwnerTable";
import type { LotOwner } from "../../../types";

const lotOwners: LotOwner[] = [
  {
    id: "lo1",
    building_id: "b1",
    lot_number: "1A",
    emails: ["owner1@example.com"],
    unit_entitlement: 100,
    financial_position: "normal",
    proxy_email: null,
  },
  {
    id: "lo2",
    building_id: "b1",
    lot_number: "2B",
    emails: ["owner2@example.com"],
    unit_entitlement: 200,
    financial_position: "in_arrear",
    proxy_email: "proxy@example.com",
  },
];

describe("LotOwnerTable", () => {
  it("renders lot owners", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("1A")).toBeInTheDocument();
    expect(screen.getByText("owner1@example.com")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("2B")).toBeInTheDocument();
  });

  it("shows empty message when no lot owners", () => {
    render(<LotOwnerTable lotOwners={[]} onEdit={() => {}} />);
    expect(screen.getByText("No lot owners found.")).toBeInTheDocument();
  });

  it("shows loading row in table body when isLoading and no data yet", () => {
    render(<LotOwnerTable lotOwners={[]} onEdit={() => {}} isLoading={true} />);
    expect(screen.getByText("Loading lot owners...")).toBeInTheDocument();
    expect(screen.queryByText("No lot owners found.")).not.toBeInTheDocument();
  });

  it("does not show loading row when isLoading but data is already present", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} isLoading={true} />);
    expect(screen.queryByText("Loading lot owners...")).not.toBeInTheDocument();
    expect(screen.getByText("1A")).toBeInTheDocument();
  });

  it("calls onEdit with correct lot owner when Edit clicked", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={onEdit} />);
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    await user.click(editButtons[0]);
    expect(onEdit).toHaveBeenCalledWith(lotOwners[0]);
  });

  it("renders table headers including Financial Position and Proxy", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("Lot Number")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Unit Entitlement")).toBeInTheDocument();
    expect(screen.getByText("Financial Position")).toBeInTheDocument();
    expect(screen.getByText("Proxy")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  it("shows In Arrear badge for in_arrear lot owner", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("In Arrear")).toBeInTheDocument();
  });

  it("shows Normal text for normal lot owner", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("Normal")).toBeInTheDocument();
  });

  it("shows proxy email when proxy is nominated", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
  });

  it("shows None when no proxy is nominated", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  // --- Pagination top + bottom ---

  it("does not show pagination controls when lot owners fit on one page", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows pagination controls at both top and bottom when there are more than 25 lot owners", () => {
    const manyLotOwners: typeof lotOwners = Array.from({ length: 26 }, (_, i) => ({
      id: `lo${i + 1}`,
      building_id: "b1",
      lot_number: `${i + 1}`,
      emails: [`owner${i + 1}@example.com`],
      unit_entitlement: 100,
      financial_position: "normal" as const,
      proxy_email: null,
    }));
    render(<LotOwnerTable lotOwners={manyLotOwners} onEdit={() => {}} />);
    const prevButtons = screen.getAllByRole("button", { name: "Previous page" });
    const nextButtons = screen.getAllByRole("button", { name: "Next page" });
    expect(prevButtons).toHaveLength(2);
    expect(nextButtons).toHaveLength(2);
  });

  it("navigating to page 2 via top Next button shows lot owner 26", async () => {
    const user = userEvent.setup();
    const manyLotOwners: typeof lotOwners = Array.from({ length: 26 }, (_, i) => ({
      id: `lo${i + 1}`,
      building_id: "b1",
      lot_number: `lot-${i + 1}`,
      emails: [`owner${i + 1}@example.com`],
      unit_entitlement: 100,
      financial_position: "normal" as const,
      proxy_email: null,
    }));
    const { container } = render(<LotOwnerTable lotOwners={manyLotOwners} onEdit={() => {}} />);
    // Page 1 shows 25 rows
    const tbody = container.querySelector("tbody")!;
    expect(tbody.querySelectorAll("tr")).toHaveLength(25);
    // Use the first (top) Next page button
    await user.click(screen.getAllByRole("button", { name: "Next page" })[0]);
    // Page 2 shows only the 26th lot owner
    expect(tbody.querySelectorAll("tr")).toHaveLength(1);
    expect(screen.getByText("lot-26")).toBeInTheDocument();
    expect(screen.queryByText("lot-1")).not.toBeInTheDocument();
  });
});
