import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

  it("renders sortable table headers for all columns", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.getByRole("button", { name: /Lot Number/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unit Entitlement/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Financial Position/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Proxy/ })).toBeInTheDocument();
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

  // --- Sort: default state ---

  it("Lot Number column header shows aria-sort='ascending' by default", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const lotNumberBtn = screen.getByRole("button", { name: /Lot Number/ });
    const th = lotNumberBtn.closest("th");
    expect(th).toHaveAttribute("aria-sort", "ascending");
  });

  it("other columns show aria-sort='none' by default", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const ueBtn = screen.getByRole("button", { name: /Unit Entitlement/ });
    const fpBtn = screen.getByRole("button", { name: /Financial Position/ });
    const emailBtn = screen.getByRole("button", { name: /Email/ });
    const proxyBtn = screen.getByRole("button", { name: /Proxy/ });
    expect(ueBtn.closest("th")).toHaveAttribute("aria-sort", "none");
    expect(fpBtn.closest("th")).toHaveAttribute("aria-sort", "none");
    expect(emailBtn.closest("th")).toHaveAttribute("aria-sort", "none");
    expect(proxyBtn.closest("th")).toHaveAttribute("aria-sort", "none");
  });

  it("default sort is Lot Number asc — 1A appears before 2B", () => {
    render(<LotOwnerTable lotOwners={[...lotOwners].reverse()} onEdit={() => {}} />);
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // First row should be lot 1A (natural sort 1A < 2B)
    expect(rows[0].textContent).toContain("1A");
    expect(rows[1].textContent).toContain("2B");
  });

  // --- Sort: Name ---

  it("clicking Name sorts by name ascending", async () => {
    const user = userEvent.setup();
    const nameSortLots: LotOwner[] = [
      { ...lotOwners[1], given_name: "Zelda", surname: "Anders", owner_emails: [] },
      { ...lotOwners[0], given_name: "Alice", surname: "Smith", owner_emails: [] },
    ];
    render(<LotOwnerTable lotOwners={nameSortLots} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Name/ });
    await user.click(btn);
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("Alice");
    expect(rows[1].textContent).toContain("Zelda");
  });

  it("clicking Name twice sorts by name descending", async () => {
    const user = userEvent.setup();
    const nameSortLots: LotOwner[] = [
      { ...lotOwners[0], given_name: "Alice", surname: "Smith", owner_emails: [] },
      { ...lotOwners[1], given_name: "Zelda", surname: "Anders", owner_emails: [] },
    ];
    render(<LotOwnerTable lotOwners={nameSortLots} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Name/ });
    await user.click(btn); // asc
    await user.click(btn); // desc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("Zelda");
    expect(rows[1].textContent).toContain("Alice");
  });

  // --- Sort: Lot Number ---

  it("clicking Lot Number twice toggles to descending order", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Lot Number/ });
    // First click: already ascending → desc
    await user.click(btn);
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("2B");
    expect(rows[1].textContent).toContain("1A");
  });

  it("clicking Lot Number a third time toggles back to ascending", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Lot Number/ });
    await user.click(btn); // → desc
    await user.click(btn); // → asc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("1A");
  });

  // --- Sort: Unit Entitlement ---

  it("clicking Unit Entitlement sorts by entitlement ascending", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={[...lotOwners].reverse()} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Unit Entitlement/ });
    await user.click(btn);
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // 100 < 200, so lo1 (100) should be first
    expect(rows[0].textContent).toContain("100");
    expect(rows[1].textContent).toContain("200");
  });

  it("clicking Unit Entitlement twice sorts by entitlement descending", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Unit Entitlement/ });
    await user.click(btn); // asc
    await user.click(btn); // desc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // 200 > 100, so lo2 (200) should be first
    expect(rows[0].textContent).toContain("200");
  });

  // --- Sort: Financial Position ---

  it("clicking Financial Position sorts with normal < in_arrear (ascending)", async () => {
    const user = userEvent.setup();
    const mixed: LotOwner[] = [
      { ...lotOwners[1] }, // in_arrear first
      { ...lotOwners[0] }, // normal second
    ];
    render(<LotOwnerTable lotOwners={mixed} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Financial Position/ });
    await user.click(btn);
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // normal (lo1: 1A) should be first
    expect(rows[0].textContent).toContain("1A");
    expect(rows[1].textContent).toContain("2B");
  });

  it("clicking Financial Position twice shows in_arrear lots first (descending)", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Financial Position/ });
    await user.click(btn); // asc
    await user.click(btn); // desc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // in_arrear (lo2: 2B) should be first
    expect(rows[0].textContent).toContain("2B");
  });

  // --- Sort: Email ---

  it("clicking Email sorts by first email ascending (case-insensitive)", async () => {
    const user = userEvent.setup();
    // Provide reversed order to confirm sorting actually works
    const emailSortLots: LotOwner[] = [
      {
        ...lotOwners[1],
        emails: ["zz@example.com"],
        owner_emails: [{ id: "em-zz", email: "zz@example.com", given_name: null, surname: null }],
      }, // 'zz' would sort after 'aa'
      {
        ...lotOwners[0],
        emails: ["aa@example.com"],
        owner_emails: [{ id: "em-aa", email: "aa@example.com", given_name: null, surname: null }],
      },
    ];
    render(<LotOwnerTable lotOwners={emailSortLots} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Email/ });
    await user.click(btn);
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("aa@example.com");
    expect(rows[1].textContent).toContain("zz@example.com");
  });

  it("clicking Email twice sorts by email descending", async () => {
    const user = userEvent.setup();
    const emailSortLots: LotOwner[] = [
      {
        ...lotOwners[0],
        emails: ["aa@example.com"],
        owner_emails: [{ id: "em-aa", email: "aa@example.com", given_name: null, surname: null }],
      },
      {
        ...lotOwners[1],
        emails: ["zz@example.com"],
        owner_emails: [{ id: "em-zz", email: "zz@example.com", given_name: null, surname: null }],
      },
    ];
    render(<LotOwnerTable lotOwners={emailSortLots} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Email/ });
    await user.click(btn); // asc
    await user.click(btn); // desc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("zz@example.com");
    expect(rows[1].textContent).toContain("aa@example.com");
  });

  it("lot owner with no emails sorts to front when email sort is ascending (empty string < any email)", async () => {
    const user = userEvent.setup();
    const noEmailLot: LotOwner = {
      id: "lo3",
      building_id: "b1",
      lot_number: "3C",
      given_name: null,
      surname: null,
      owner_emails: [],
      emails: [],
      unit_entitlement: 50,
      financial_position: "normal",
      proxy_email: null,
      proxy_given_name: null,
      proxy_surname: null,
    };
    render(<LotOwnerTable lotOwners={[lotOwners[0], noEmailLot]} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Email/ });
    await user.click(btn); // asc
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // Empty email sorts first when ascending
    expect(rows[0].textContent).toContain("3C");
    expect(rows[1].textContent).toContain("1A");
  });

  // --- Sort: Proxy ---

  it("clicking Proxy sorts lots without proxy first (ascending: no proxy < has proxy)", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={[lotOwners[1], lotOwners[0]]} onEdit={() => {}} />);
    // lotOwners[1] has proxy, lotOwners[0] does not
    const btn = screen.getByRole("button", { name: /Proxy/ });
    await user.click(btn); // asc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // No-proxy lot (1A) should be first
    expect(rows[0].textContent).toContain("1A");
    expect(rows[1].textContent).toContain("2B");
  });

  it("clicking Proxy twice puts lots with proxy first (descending)", async () => {
    const user = userEvent.setup();
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Proxy/ });
    await user.click(btn); // asc
    await user.click(btn); // desc
    expect(btn.closest("th")).toHaveAttribute("aria-sort", "descending");
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    // Has-proxy lot (2B) should be first in descending
    expect(rows[0].textContent).toContain("2B");
    expect(rows[1].textContent).toContain("1A");
  });

  it("proxy sort breaks ties by proxy email value", async () => {
    const user = userEvent.setup();
    const twoProxyLots: LotOwner[] = [
      { ...lotOwners[0], proxy_email: "zebra@proxy.com", proxy_given_name: null, proxy_surname: null },
      { ...lotOwners[1], proxy_email: "apple@proxy.com", proxy_given_name: null, proxy_surname: null },
    ];
    render(<LotOwnerTable lotOwners={twoProxyLots} onEdit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Proxy/ });
    await user.click(btn); // asc — both have proxies, so sort by email value
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("apple@proxy.com");
    expect(rows[1].textContent).toContain("zebra@proxy.com");
  });

  // --- Sort resets page to 1 ---

  it("clicking a sort column resets page to 1", async () => {
    const user = userEvent.setup();
    const manyLotOwners: LotOwner[] = Array.from({ length: 26 }, (_, i) => ({
      id: `lo${i + 1}`,
      building_id: "b1",
      lot_number: `${String(i + 1).padStart(3, "0")}`,
      given_name: null,
      surname: null,
      owner_emails: [] as LotOwner["owner_emails"],
      emails: [],
      unit_entitlement: i + 1,
      financial_position: "normal" as const,
      proxy_email: null,
      proxy_given_name: null,
      proxy_surname: null,
    }));
    render(<LotOwnerTable lotOwners={manyLotOwners} onEdit={() => {}} />);
    // Navigate to page 2
    await user.click(screen.getAllByRole("button", { name: "Next page" })[0]);
    expect(screen.getByText("026")).toBeInTheDocument();
    // Now click a sort column — should reset to page 1
    await user.click(screen.getByRole("button", { name: /Unit Entitlement/ }));
    expect(screen.queryByText("026")).not.toBeInTheDocument();
    expect(screen.getByText("001")).toBeInTheDocument();
  });

  // --- Pagination top + bottom ---

  it("does not show pagination controls when lot owners fit on one page", () => {
    render(<LotOwnerTable lotOwners={lotOwners} onEdit={() => {}} />);
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows pagination controls at both top and bottom when there are more than 25 lot owners", () => {
    const manyLotOwners: LotOwner[] = Array.from({ length: 26 }, (_, i) => ({
      id: `lo${i + 1}`,
      building_id: "b1",
      lot_number: `${i + 1}`,
      given_name: null,
      surname: null,
      owner_emails: [{ id: `em${i + 1}`, email: `owner${i + 1}@example.com`, given_name: null, surname: null }],
      emails: [`owner${i + 1}@example.com`],
      unit_entitlement: 100,
      financial_position: "normal" as const,
      proxy_email: null,
      proxy_given_name: null,
      proxy_surname: null,
    }));
    render(<LotOwnerTable lotOwners={manyLotOwners} onEdit={() => {}} />);
    const prevButtons = screen.getAllByRole("button", { name: "Previous page" });
    const nextButtons = screen.getAllByRole("button", { name: "Next page" });
    expect(prevButtons).toHaveLength(2);
    expect(nextButtons).toHaveLength(2);
  });

  it("navigating to page 2 via top Next button shows lot owner 26", async () => {
    const user = userEvent.setup();
    const manyLotOwners: LotOwner[] = Array.from({ length: 26 }, (_, i) => ({
      id: `lo${i + 1}`,
      building_id: "b1",
      lot_number: `lot-${i + 1}`,
      given_name: null,
      surname: null,
      owner_emails: [{ id: `em${i + 1}`, email: `owner${i + 1}@example.com`, given_name: null, surname: null }],
      emails: [`owner${i + 1}@example.com`],
      unit_entitlement: 100,
      financial_position: "normal" as const,
      proxy_email: null,
      proxy_given_name: null,
      proxy_surname: null,
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

  // --- Natural sort boundary: numeric lot numbers ---

  it("sorts lot numbers naturally so '10' comes after '9', not before '2'", async () => {
    const user = userEvent.setup();
    const numericLots: LotOwner[] = [
      { id: "a", building_id: "b1", lot_number: "10", given_name: null, surname: null, owner_emails: [], emails: [], unit_entitlement: 1, financial_position: "normal", proxy_email: null, proxy_given_name: null, proxy_surname: null },
      { id: "b", building_id: "b1", lot_number: "9", given_name: null, surname: null, owner_emails: [], emails: [], unit_entitlement: 2, financial_position: "normal", proxy_email: null, proxy_given_name: null, proxy_surname: null },
      { id: "c", building_id: "b1", lot_number: "2", given_name: null, surname: null, owner_emails: [], emails: [], unit_entitlement: 3, financial_position: "normal", proxy_email: null, proxy_given_name: null, proxy_surname: null },
    ];
    render(<LotOwnerTable lotOwners={numericLots} onEdit={() => {}} />);
    // Default sort is lot_number asc — numeric order: 2, 9, 10
    const tbody = document.querySelector("tbody")!;
    const rows = within(tbody).getAllByRole("row");
    expect(rows[0].textContent).toContain("2");
    expect(rows[1].textContent).toContain("9");
    expect(rows[2].textContent).toContain("10");
    // Click to desc
    await user.click(screen.getByRole("button", { name: /Lot Number/ }));
    const rowsDesc = within(tbody).getAllByRole("row");
    expect(rowsDesc[0].textContent).toContain("10");
    expect(rowsDesc[1].textContent).toContain("9");
    expect(rowsDesc[2].textContent).toContain("2");
  });
});
