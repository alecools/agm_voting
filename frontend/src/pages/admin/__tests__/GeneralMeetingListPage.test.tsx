import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
      http.get("http://localhost:8000/api/admin/general-meetings", () => {
        return HttpResponse.json({ detail: "Error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load General Meetings.")).toBeInTheDocument();
    });
  });

  // --- Building filter ---

  it("renders building filter dropdown with All buildings default", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Building")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Building") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "All buildings" })).toBeInTheDocument();
  });

  it("renders building options from the buildings API (only non-archived)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Beta Court" })).toBeInTheDocument();
  });

  it("does not show archived buildings in the filter dropdown", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("option", { name: "Gamma House" })).not.toBeInTheDocument();
  });

  it("filters meetings when a building is selected (sends building_id to server)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Building");
    await user.selectOptions(select, "b1");
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
    const select = screen.getByLabelText("Building");
    await user.selectOptions(select, "b2");
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
    const select = screen.getByLabelText("Building");
    await user.selectOptions(select, "b2");
    await waitFor(() => {
      expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    });
    await user.selectOptions(select, "");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
  });

  it("reads building URL param on mount and pre-selects the building", async () => {
    renderPage("?building=b2");
    await waitFor(() => {
      // Should show only Beta Court meeting
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    expect(screen.queryByText("2026 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Building") as HTMLSelectElement;
    expect(select.value).toBe("b2");
  });

  it("pre-selects b1 from URL param and shows only Alpha Tower meetings", async () => {
    renderPage("?building=b1");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Building") as HTMLSelectElement;
    expect(select.value).toBe("b1");
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
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
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
    await user.selectOptions(screen.getByLabelText("Building"), "b1");
    // Status filter should still be "open" after changing building
    const statusSelect = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(statusSelect.value).toBe("open");
  });

  it("changing status filter preserves the building filter in URL", async () => {
    const user = userEvent.setup();
    renderPage("?building=b1");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText("Status"), "pending");
    // Building filter should still be "b1" after changing status
    const buildingSelect = screen.getByLabelText("Building") as HTMLSelectElement;
    expect(buildingSelect.value).toBe("b1");
    // Only the pending b1 meeting should show
    await waitFor(() => {
      expect(screen.getByText("2026 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
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
      http.get("http://localhost:8000/api/admin/general-meetings/count", () => {
        return HttpResponse.json({ count: 21 });
      }),
      http.get("http://localhost:8000/api/admin/general-meetings", ({ request }) => {
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
    expect(screen.getAllByRole("button", { name: "2" })[0]).toBeInTheDocument();
  });
});
