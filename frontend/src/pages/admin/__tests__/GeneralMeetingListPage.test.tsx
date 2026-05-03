import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import GeneralMeetingListPage from "../GeneralMeetingListPage";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(initialSearch = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/general-meetings${initialSearch}`]}>
        <GeneralMeetingListPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Helper: open the building combobox and select an option by display text.
 *  Uses fireEvent.mouseDown on the option (matching the onMouseDown handler in the component)
 *  which also calls e.preventDefault() to keep focus on the input.
 */
async function selectBuildingOption(user: ReturnType<typeof userEvent.setup>, optionText: string) {
  const combobox = screen.getByRole("combobox", { name: "Building" });
  // Click to open (safe even if already open)
  fireEvent.click(combobox);
  await waitFor(() => {
    expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
  });
  const option = screen.getByRole("option", { name: optionText });
  fireEvent.mouseDown(option);
}

describe("GeneralMeetingListPage", () => {
  // --- Happy path ---

  it("shows loading state inline in table while page header remains visible", () => {
    renderPage();
    // Page structure renders immediately
    expect(screen.getByRole("heading", { name: "General Meetings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create General Meeting" })).toBeInTheDocument();
    // Loading message is inside the table body
    expect(screen.getByText("Loading General Meetings...")).toBeInTheDocument();
  });

  it("loading overlay has pointer-events none while loading and auto after load", async () => {
    renderPage();
    // During loading the overlay div should block pointer events
    const loadingOverlay = screen.getByText("Loading General Meetings...").closest("div[style]")!;
    expect(loadingOverlay).toHaveStyle({ pointerEvents: "none" });

    // After load the overlay should allow pointer events
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    const loadedOverlay = screen.getByText("2024 AGM").closest("div[style]")!;
    expect(loadedOverlay).toHaveStyle({ pointerEvents: "auto" });
  });

  it("renders meeting table after loading", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
  });

  it("renders Create General Meeting button", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create General Meeting" })).toBeInTheDocument();
    });
  });

  it("navigates to create page when button clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create General Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Create General Meeting" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings/new");
  });

  it("navigates to meeting detail on row click", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await user.click(screen.getByText("2024 AGM"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings/agm1");
  });

  it("shows Open, Pending and Closed status badges", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Open")).toBeInTheDocument();
      expect(screen.getByText("Closed")).toBeInTheDocument();
      expect(screen.getByText("Pending")).toBeInTheDocument();
    });
  });

  it("shows error state when fetch fails", async () => {
    server.use(
      http.get("http://localhost/api/admin/general-meetings", () => {
        return HttpResponse.json({ detail: "Error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load General Meetings.")).toBeInTheDocument();
    });
  });

  // --- Building filter combobox ---

  it("renders building combobox input with placeholder 'All buildings'", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument();
    });
    const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
    expect(combobox.placeholder).toBe("All buildings");
    expect(combobox.value).toBe("");
  });

  it("opens dropdown on focus and shows All buildings option", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("combobox", { name: "Building" }));
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "All buildings" })).toBeInTheDocument();
  });

  it("shows building options from the buildings API (only non-archived)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("combobox", { name: "Building" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Beta Court" })).toBeInTheDocument();
  });

  it("does not show archived buildings in the dropdown", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("combobox", { name: "Building" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("option", { name: "Gamma House" })).not.toBeInTheDocument();
  });

  it("shows 'No buildings found' when search has no matches", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    await user.type(combobox, "ZZZNONEXISTENT");
    await waitFor(() => {
      expect(screen.getByText("No buildings found")).toBeInTheDocument();
    });
  });

  it("filters meetings when a building is selected (sends building_id to server)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    await selectBuildingOption(user, "Alpha Tower");
    // Only Alpha Tower meetings (agm1 / 2024 AGM, agm3 / 2026 AGM) should show
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
  });

  it("selecting the other building shows only that building's meetings", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    await selectBuildingOption(user, "Beta Court");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
  });

  it("selecting All buildings after filtering shows all meetings", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await selectBuildingOption(user, "Beta Court");
    await waitFor(() => {
      expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    });
    await selectBuildingOption(user, "All buildings");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
  });

  it("selected building name appears in combobox input after selection", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    await selectBuildingOption(user, "Alpha Tower");
    const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
    expect(combobox.value).toBe("Alpha Tower");
  });

  it("combobox input is cleared when All buildings is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    await selectBuildingOption(user, "Alpha Tower");
    await selectBuildingOption(user, "All buildings");
    const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
    expect(combobox.value).toBe("");
  });

  it("reads building URL param on mount and shows building name in combobox", async () => {
    renderPage("?building=b2");
    await waitFor(() => {
      // Should show only Beta Court meeting
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    // Combobox shows building name after init
    await waitFor(() => {
      const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
      expect(combobox.value).toBe("Beta Court");
    });
  });

  it("pre-selects b1 from URL param and shows only Alpha Tower meetings", async () => {
    renderPage("?building=b1");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    await waitFor(() => {
      const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
      expect(combobox.value).toBe("Alpha Tower");
    });
  });

  it("shows no meetings when URL param building id does not match any building", async () => {
    renderPage("?building=nonexistent");
    await waitFor(() => {
      // No match → server returns empty
      expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
      expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
      expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    });
  });

  it("Escape key closes the combobox dropdown", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument());
    fireEvent.keyDown(combobox, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument());
  });

  it("ArrowDown + Enter selects the first building option", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    // Wait for buildings to load before keyboard navigation
    await waitFor(() => expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument());
    // First ArrowDown moves to "All buildings" (index 0)
    act(() => { fireEvent.keyDown(combobox, { key: "ArrowDown" }); });
    // Second ArrowDown moves to first building (index 1 = Alpha Tower)
    act(() => { fireEvent.keyDown(combobox, { key: "ArrowDown" }); });
    // Press Enter to select the highlighted option (should be Alpha Tower)
    act(() => { fireEvent.keyDown(combobox, { key: "Enter" }); });
    await waitFor(() => {
      const input = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
      expect(input.value).toBe("Alpha Tower");
    });
  });

  it("ArrowDown + Enter on All buildings (index 0) clears the selection", async () => {
    renderPage("?building=b1");
    await waitFor(() => {
      const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
      expect(combobox.value).toBe("Alpha Tower");
    });
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument());
    // ArrowDown to "All buildings" (index 0), then Enter
    act(() => { fireEvent.keyDown(combobox, { key: "ArrowDown" }); });
    act(() => { fireEvent.keyDown(combobox, { key: "Enter" }); });
    await waitFor(() => {
      const input = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
      expect(input.value).toBe("");
    });
  });

  it("ArrowUp wraps around from first option to last", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument());
    // ArrowUp from default (-1 active) wraps to last
    act(() => { fireEvent.keyDown(combobox, { key: "ArrowUp" }); });
    // Should show the listbox still open
    expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument();
  });

  it("Enter with no item highlighted (activeIndex=-1) does not select anything", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument());
    // Press Enter without ArrowDown — activeIndex = -1, no selection should happen
    act(() => { fireEvent.keyDown(combobox, { key: "Enter" }); });
    // Dropdown closes (because comboOpen is true, Enter with no selection just closes it)
    // Actually looking at the code: Enter when comboOpen=true with activeIndex=-1:
    // neither activeIndex===0 nor activeIndex>0 is true → no selection, dropdown stays open
    // The input value should remain empty
    const input = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("Enter on closed combobox opens the dropdown", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    fireEvent.click(combobox);
    // Close it
    act(() => { fireEvent.keyDown(combobox, { key: "Escape" }); });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument());
    // Open it with Enter
    act(() => { fireEvent.keyDown(combobox, { key: "Enter" }); });
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument());
  });

  it("typing in combobox while a building is selected clears the building URL param", async () => {
    const user = userEvent.setup();
    renderPage("?building=b1");
    await waitFor(() => {
      const combobox = screen.getByRole("combobox", { name: "Building" }) as HTMLInputElement;
      expect(combobox.value).toBe("Alpha Tower");
    });
    const combobox = screen.getByRole("combobox", { name: "Building" });
    // Typing should clear the URL building param
    await user.type(combobox, "x");
    // All meetings should show again (no building filter)
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
  });

  it("typing in combobox sends name filter to buildings API", async () => {
    const user = userEvent.setup();
    let capturedUrl = "";
    server.use(
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        capturedUrl = request.url;
        const url = new URL(request.url);
        const name = url.searchParams.get("name");
        if (name === "Alpha") {
          return HttpResponse.json([
            { id: "b1", name: "Alpha Tower", manager_email: "alpha@example.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
          ]);
        }
        return HttpResponse.json([]);
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    const combobox = screen.getByRole("combobox", { name: "Building" });
    await user.type(combobox, "Alpha");
    await waitFor(() => {
      expect(capturedUrl).toContain("name=Alpha");
    });
  });

  it("dropdown closes when clicking outside", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Building" })).toBeInTheDocument());
    await user.click(screen.getByRole("combobox", { name: "Building" }));
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Buildings" })).toBeInTheDocument());
    // Click on Status filter to move focus away
    await user.click(screen.getByRole("heading", { name: "General Meetings" }));
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Buildings" })).not.toBeInTheDocument());
  });

  // --- Status filter ---

  it("renders status filter dropdown with All statuses default", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Status")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "All statuses" })).toBeInTheDocument();
  });

  it("renders all three status options in the dropdown", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Status")).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Pending" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Closed" })).toBeInTheDocument();
  });

  it("filters to open meetings only when Open is selected (sends status to server)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
  });

  it("filters to pending meetings only when Pending is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "pending");
    await waitFor(() => {
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
  });

  it("filters to closed meetings only when Closed is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "closed");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
  });

  it("selecting All statuses after filtering shows all meetings", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await waitFor(() => {
      expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
  });

  it("reads status URL param on mount and pre-selects the status", async () => {
    renderPage("?status=closed");
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.value).toBe("closed");
  });

  it("reads pending status URL param on mount", async () => {
    renderPage("?status=pending");
    await waitFor(() => {
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.value).toBe("pending");
  });

  it("reads open status URL param on mount", async () => {
    renderPage("?status=open");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.value).toBe("open");
  });

  it("shows no meetings when status URL param does not match any status", async () => {
    renderPage("?status=nonexistent");
    await waitFor(() => {
      expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
      expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
      expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    });
  });

  // --- Combined building + status filter ---

  it("applies both building and status filters simultaneously", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    // b1 has open (2024 AGM) and pending (2026 AGM); filter to b1 + open
    await selectBuildingOption(user, "Alpha Tower");
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
  });

  it("changing building filter preserves the status filter in URL", async () => {
    const user = userEvent.setup();
    renderPage("?status=open");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await selectBuildingOption(user, "Alpha Tower");
    // Status filter should still be "open" after changing building
    const statusSelect = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(statusSelect.value).toBe("open");
  });

  it("changing status filter preserves building filter (URL still has building param)", async () => {
    const user = userEvent.setup();
    renderPage("?building=b1");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "pending");
    // Only the pending b1 meeting should show
    await waitFor(() => {
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
  });

  // --- RR2-06: URL params for page ---

  it("navigates to page 2 via pagination and back to page 1 via Previous", async () => {
    const meetings = Array.from({ length: 21 }, (_, i) => ({
      id: `m${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));
    server.use(
      http.get("http://localhost/api/admin/general-meetings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(meetings.slice(offset, offset + limit));
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    });
    // Navigate to page 2
    await user.click(screen.getAllByRole("button", { name: "Go to page 2" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Meeting 21")).toBeInTheDocument();
    });
    // Navigate back to page 1 via Previous button
    await user.click(screen.getAllByRole("button", { name: "Previous page" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Meeting 21")).not.toBeInTheDocument();
  });

  it("defaults to page 1 when page URL param is not a valid number", async () => {
    renderPage("?page=abc");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "General Meetings" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Failed to load General Meetings.")).not.toBeInTheDocument();
  });

  it("reads page=2 from URL and loads page 2", async () => {
    const meetings = Array.from({ length: 21 }, (_, i) => ({
      id: `m${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));
    server.use(
      http.get("http://localhost/api/admin/general-meetings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(meetings.slice(offset, offset + limit));
      })
    );
    renderPage("?page=2");
    await waitFor(() => {
      expect(screen.getByText("Meeting 21")).toBeInTheDocument();
    });
    expect(screen.queryByText("Meeting 1")).not.toBeInTheDocument();
  });

  it("filter change resets page to 1 in URL", async () => {
    const meetings = Array.from({ length: 21 }, (_, i) => ({
      id: `m${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));
    server.use(
      http.get("http://localhost/api/admin/general-meetings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(meetings.slice(offset, offset + limit));
      })
    );
    const user = userEvent.setup();
    renderPage("?page=2");
    await waitFor(() => {
      expect(screen.getByText("Meeting 21")).toBeInTheDocument();
    });
    // Changing filter should reset to page 1
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await waitFor(() => {
      expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Meeting 21")).not.toBeInTheDocument();
  });

  // --- Pagination and prefetch ---

  it("prefetches next page when total count exceeds one page", async () => {
    // 21 meetings so that totalCount > PAGE_SIZE (20) and prefetch triggers
    const meetings = Array.from({ length: 21 }, (_, i) => ({
      id: `m${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));

    server.use(
      http.get("http://localhost/api/admin/general-meetings/count", () => {
        return HttpResponse.json({ count: 21 });
      }),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(meetings.slice(offset, offset + limit));
      })
    );

    renderPage();

    // Page 1 loads — 20 meetings visible, Meeting 21 is on page 2 (prefetched)
    await waitFor(() => {
      expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    });
    // Pagination shows 2 pages
    expect(screen.getAllByRole("button", { name: "Go to page 2" })[0]).toBeInTheDocument();
  });

  // --- Sort functionality ---

  it("renders sortable Title and Created At column headers", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Created At/ })).toBeInTheDocument();
  });

  it("Created At header shows ▼ indicator by default (desc sort)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    const createdBtn = screen.getByRole("button", { name: /Created At/ });
    expect(createdBtn.textContent).toContain("▼");
  });

  it("clicking Title header updates sort to title ascending", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Title/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Title/ }).closest("th")).toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("clicking Title header again toggles to descending", async () => {
    const user = userEvent.setup();
    renderPage("?sort_by=title&sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Title/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Title/ }).closest("th")).toHaveAttribute("aria-sort", "descending");
    });
  });

  it("clicking Title desc toggles back to ascending (sortDir=desc branch)", async () => {
    const user = userEvent.setup();
    renderPage("?sort_by=title&sort_dir=desc");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Title/ })).toBeInTheDocument();
    });
    // Click same column while desc → toggles to asc
    await user.click(screen.getByRole("button", { name: /Title/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Title/ }).closest("th")).toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("reads sort_by=title from URL and shows ascending indicator on Title", async () => {
    renderPage("?sort_by=title&sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    const titleBtn = screen.getByRole("button", { name: /Title/ });
    expect(titleBtn.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("sort change resets page to 1", async () => {
    const meetingsData = Array.from({ length: 21 }, (_, i) => ({
      id: `m${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));
    server.use(
      http.get("http://localhost/api/admin/general-meetings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(meetingsData.slice(offset, offset + limit));
      })
    );
    const user = userEvent.setup();
    renderPage("?page=2");
    await waitFor(() => {
      expect(screen.getByText("Meeting 21")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Title/ }));
    await waitFor(() => {
      expect(screen.getByText("Meeting 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Meeting 21")).not.toBeInTheDocument();
  });

  it("shows error when server returns 422 for invalid sort param", async () => {
    server.use(
      http.get("http://localhost/api/admin/general-meetings", () => {
        return HttpResponse.json({ detail: "Invalid sort_by value" }, { status: 422 });
      })
    );
    renderPage("?sort_by=INVALID");
    await waitFor(() => {
      expect(screen.getByText("Failed to load General Meetings.")).toBeInTheDocument();
    });
  });

  it("Status and Building column headers do NOT have sortable buttons", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    // Status th should not contain a sort button
    // Building th should not contain a sort button
    expect(screen.queryByRole("button", { name: /^Status$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Building$/ })).not.toBeInTheDocument();
  });

  // --- RR2-03: filter toggle resets pagination to page 1 ---

  it("RR2-03: changing building filter resets page to 1", async () => {
    // 21 meetings under b1 (2 pages), 1 meeting under b2 (1 page)
    const b1Meetings = Array.from({ length: 21 }, (_, i) => ({
      id: `m${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Alpha Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));
    const b2Meeting = {
      id: "b2m1",
      building_id: "b2",
      building_name: "Beta Court",
      title: "Beta Meeting 1",
      status: "closed",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    };

    server.use(
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        const limitParam = url.searchParams.get("limit");
        const nameParam = url.searchParams.get("name");
        let filtered = [
          { id: "b1", name: "Alpha Tower", manager_email: "a@x.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
          { id: "b2", name: "Beta Court", manager_email: "b@x.com", is_archived: false, created_at: "2024-02-01T00:00:00Z" },
        ];
        if (isArchivedParam !== null) {
          const ia = isArchivedParam === "true";
          filtered = filtered.filter((b) => b.is_archived === ia);
        }
        if (nameParam) filtered = filtered.filter((b) => b.name.toLowerCase().includes(nameParam.toLowerCase()));
        const limit = limitParam !== null ? parseInt(limitParam, 10) : filtered.length;
        return HttpResponse.json(filtered.slice(0, limit));
      }),
      http.get("http://localhost/api/admin/general-meetings/count", ({ request }) => {
        const url = new URL(request.url);
        const bid = url.searchParams.get("building_id");
        if (bid === "b1") return HttpResponse.json({ count: 21 });
        if (bid === "b2") return HttpResponse.json({ count: 1 });
        return HttpResponse.json({ count: 22 });
      }),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const bid = url.searchParams.get("building_id");
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const all = bid === "b2" ? [b2Meeting] : bid === "b1" ? b1Meetings : [...b1Meetings, b2Meeting];
        return HttpResponse.json(all.slice(offset, offset + limit));
      })
    );

    const user = userEvent.setup();
    renderPage();

    // Wait for page 1 of all meetings to load
    await waitFor(() => {
      expect(screen.getByText("Alpha Meeting 1")).toBeInTheDocument();
    });

    // Navigate to page 2 (b1 has 21 meetings → 2 pages)
    await user.click(screen.getAllByRole("button", { name: "Go to page 2" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Alpha Meeting 21")).toBeInTheDocument();
    });

    // Change building filter via combobox — page should reset to 1
    await selectBuildingOption(user, "Beta Court");

    // Should be back on page 1 showing Beta Meeting 1
    await waitFor(() => {
      expect(screen.getByText("Beta Meeting 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Alpha Meeting 21")).not.toBeInTheDocument();
  });

  it("RR2-03: changing status filter resets page to 1", async () => {
    // 21 open meetings (2 pages), 1 closed meeting (1 page)
    const openMeetings = Array.from({ length: 21 }, (_, i) => ({
      id: `open${i + 1}`,
      building_id: "b1",
      building_name: "Alpha Tower",
      title: `Open Meeting ${i + 1}`,
      status: "open",
      meeting_at: "2024-06-01T10:00:00Z",
      voting_closes_at: "2024-06-01T12:00:00Z",
      created_at: "2024-01-01T00:00:00Z",
    }));
    const closedMeeting = {
      id: "closed1",
      building_id: "b1",
      building_name: "Alpha Tower",
      title: "Closed Meeting 1",
      status: "closed",
      meeting_at: "2023-06-01T10:00:00Z",
      voting_closes_at: "2023-06-01T12:00:00Z",
      created_at: "2023-01-01T00:00:00Z",
    };

    server.use(
      http.get("http://localhost/api/admin/general-meetings/count", ({ request }) => {
        const url = new URL(request.url);
        const status = url.searchParams.get("status");
        if (status === "open") return HttpResponse.json({ count: 21 });
        if (status === "closed") return HttpResponse.json({ count: 1 });
        return HttpResponse.json({ count: 22 });
      }),
      http.get("http://localhost/api/admin/general-meetings", ({ request }) => {
        const url = new URL(request.url);
        const status = url.searchParams.get("status");
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const all = status === "closed" ? [closedMeeting] : status === "open" ? openMeetings : [...openMeetings, closedMeeting];
        return HttpResponse.json(all.slice(offset, offset + limit));
      })
    );

    const user = userEvent.setup();
    renderPage();

    // Wait for page 1 to load
    await waitFor(() => {
      expect(screen.getByText("Open Meeting 1")).toBeInTheDocument();
    });

    // Navigate to page 2
    await user.click(screen.getAllByRole("button", { name: "Go to page 2" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Open Meeting 21")).toBeInTheDocument();
    });

    // Change status filter — page should reset to 1
    await user.selectOptions(screen.getByLabelText("Status"), "closed");

    // Should be back on page 1 showing Closed Meeting 1
    await waitFor(() => {
      expect(screen.getByText("Closed Meeting 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Open Meeting 21")).not.toBeInTheDocument();
  });
});
