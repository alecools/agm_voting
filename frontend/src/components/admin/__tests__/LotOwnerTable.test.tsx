import React from "react";
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
    email: "owner1@example.com",
    unit_entitlement: 100,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "lo2",
    building_id: "b1",
    lot_number: "2B",
    email: "owner2@example.com",
    unit_entitlement: 200,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
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

  it("calls onEdit with correct lot owner when Edit clicked", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={onEdit} />);
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    await user.click(editButtons[0]);
    expect(onEdit).toHaveBeenCalledWith(lotOwners[0]);
  });

  it("renders table headers", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("Lot Number")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Unit Entitlement")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });
});
