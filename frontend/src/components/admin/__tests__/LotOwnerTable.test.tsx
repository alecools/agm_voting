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
    given_name: "Alice",
    surname: "Smith",
    owner_emails: [{ id: "em1", email: "owner1@example.com", given_name: "Alice", surname: "Smith" }],
    emails: ["owner1@example.com"],
    unit_entitlement: 100,
    financial_position: "normal",
    proxy_email: null,
    proxy_given_name: null,
    proxy_surname: null,
  },
  {
    id: "lo2",
    building_id: "b1",
    lot_number: "2B",
    given_name: null,
    surname: null,
    owner_emails: [{ id: "em2", email: "owner2@example.com", given_name: null, surname: null }],
    emails: ["owner2@example.com"],
    unit_entitlement: 200,
    financial_position: "in_arrear",
    proxy_email: "proxy@example.com",
    proxy_given_name: null,
    proxy_surname: null,
  },
];

// --- Happy path ---

describe("LotOwnerTable", () => {
  it("renders lot owners", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("1A")).toBeInTheDocument();
    // Email column now shows "Name <email>" when name is present
    expect(screen.getByText("Alice Smith <owner1@example.com>")).toBeInTheDocument();
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

  // --- Column headers ---

  it("renders sortable headers for lot_number, email, unit_entitlement, financial_position, proxy_email", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByRole("button", { name: /Lot Number/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unit Entitlement/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Financial Position/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Proxy/ })).toBeInTheDocument();
  });

  it("renders exactly 6 column headers (Lot Number, Email, Unit Entitlement, Financial Position, Proxy, Actions)", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const ths = document.querySelectorAll("thead th");
    expect(ths).toHaveLength(6);
  });

  it("Actions column header is present", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  // --- colSpan assertions ---

  it("loading row colSpan is 6", () => {
    const { container } = render(<LotOwnerTable lotOwners={[]} onEdit={() => {}} isLoading={true} />);
    const td = container.querySelector("tbody td");
    expect(td).toHaveAttribute("colSpan", "6");
  });

  it("empty state row colSpan is 6", () => {
    const { container } = render(<LotOwnerTable lotOwners={[]} onEdit={() => {}} />);
    const td = container.querySelector("tbody td");
    expect(td).toHaveAttribute("colSpan", "6");
  });

  // --- Financial position badge ---

  it("shows In Arrear badge for in_arrear lot owner", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("In Arrear")).toBeInTheDocument();
  });

  it("shows Normal text for normal lot owner", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("Normal")).toBeInTheDocument();
  });

  // --- Proxy display ---

  it("shows proxy email when proxy is nominated (no name)", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
  });

  it("shows None when no proxy is nominated", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("shows 'Name (email)' format when proxy has name and email", () => {
    const loWithNamedProxy: LotOwner[] = [
      {
        ...lotOwners[0],
        proxy_email: "proxy@example.com",
        proxy_given_name: "Jane",
        proxy_surname: "Doe",
      },
    ];
    render(<LotOwnerTable lotOwners={loWithNamedProxy} onEdit={() => {}} />);
    expect(screen.getByText("Jane Doe (proxy@example.com)")).toBeInTheDocument();
  });

  it("shows just email when proxy has email but no name", () => {
    const loWithUnnamedProxy: LotOwner[] = [
      {
        ...lotOwners[0],
        proxy_email: "proxy@example.com",
        proxy_given_name: null,
        proxy_surname: null,
      },
    ];
    render(<LotOwnerTable lotOwners={loWithUnnamedProxy} onEdit={() => {}} />);
    expect(screen.getByText("proxy@example.com")).toBeInTheDocument();
  });

  // --- Sort props: aria-sort reflects URL-driven sort state via props ---

  it("Lot Number column shows aria-sort='ascending' when sortColumn='lot_number' and sortDir='asc'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
      />
    );
    const btn = screen.getByRole("button", { name: /Lot Number/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("Lot Number column shows aria-sort='descending' when sortColumn='lot_number' and sortDir='desc'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="desc"
      />
    );
    const btn = screen.getByRole("button", { name: /Lot Number/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("Unit Entitlement column shows aria-sort='ascending' when sortColumn='unit_entitlement'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="unit_entitlement"
        sortDir="asc"
      />
    );
    const btn = screen.getByRole("button", { name: /Unit Entitlement/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    // Other server-sortable columns should show none
    expect(screen.getByRole("button", { name: /Lot Number/ }).closest("th"))
      .toHaveAttribute("aria-sort", "none");
  });

  it("Financial Position column shows aria-sort='descending' when sortColumn='financial_position' and sortDir='desc'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="financial_position"
        sortDir="desc"
      />
    );
    const btn = screen.getByRole("button", { name: /Financial Position/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("default props: Lot Number shows aria-sort='ascending' when no sort props supplied", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Lot Number/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("non-active sortable columns show aria-sort='none'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
      />
    );
    expect(screen.getByRole("button", { name: /Unit Entitlement/ }).closest("th"))
      .toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("button", { name: /Financial Position/ }).closest("th"))
      .toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("button", { name: /Email/ }).closest("th"))
      .toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("button", { name: /Proxy/ }).closest("th"))
      .toHaveAttribute("aria-sort", "none");
  });

  // --- onSortChange callback ---

  it("clicking Lot Number header calls onSortChange with 'lot_number'", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Lot Number/ }));
    expect(onSortChange).toHaveBeenCalledWith("lot_number");
  });

  it("clicking Unit Entitlement header calls onSortChange with 'unit_entitlement'", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Unit Entitlement/ }));
    expect(onSortChange).toHaveBeenCalledWith("unit_entitlement");
  });

  it("clicking Financial Position header calls onSortChange with 'financial_position'", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Financial Position/ }));
    expect(onSortChange).toHaveBeenCalledWith("financial_position");
  });

  it("clicking Email header calls onSortChange with 'email'", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Email/ }));
    expect(onSortChange).toHaveBeenCalledWith("email");
  });

  it("clicking Proxy header calls onSortChange with 'proxy_email'", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="lot_number"
        sortDir="asc"
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Proxy/ }));
    expect(onSortChange).toHaveBeenCalledWith("proxy_email");
  });

  it("Email column shows aria-sort='ascending' when sortColumn='email' and sortDir='asc'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="email"
        sortDir="asc"
      />
    );
    const btn = screen.getByRole("button", { name: /Email/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("Proxy column shows aria-sort='descending' when sortColumn='proxy_email' and sortDir='desc'", () => {
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        sortColumn="proxy_email"
        sortDir="desc"
      />
    );
    const btn = screen.getByRole("button", { name: /Proxy/ });
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("onSortChange is called exactly once per header click", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <LotOwnerTable
        lotOwners={lotOwners}
        onEdit={() => {}}
        onSortChange={onSortChange}
      />
    );
    await user.click(screen.getByRole("button", { name: /Lot Number/ }));
    expect(onSortChange).toHaveBeenCalledTimes(1);
  });

  it("table renders rows in the order supplied by props (no client-side re-ordering)", () => {
    // If lotOwners arrive with 2B first, the table should display 2B first —
    // server-side ordering is the contract.
    const reversed = [...lotOwners].reverse();
    render(<LotOwnerTable lotOwners={reversed} onEdit={() => {}} />);
    const rows = document.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("2B");
    expect(rows[1].textContent).toContain("1A");
  });

  // --- Input validation: boundary ---

  it("renders with empty lotOwners array without crashing", () => {
    render(<LotOwnerTable lotOwners={[]} onEdit={() => {}} />);
    expect(screen.getByText("No lot owners found.")).toBeInTheDocument();
  });

  it("renders correctly without optional sort props", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByText("1A")).toBeInTheDocument();
  });
});
