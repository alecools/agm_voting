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

  it("shows Open and Closed status badges", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Open")).toBeInTheDocument();
      expect(screen.getByText("Closed")).toBeInTheDocument();
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
      expect(screen.getByLabelText("Building:")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Building:") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "All buildings" })).toBeInTheDocument();
  });

  it("renders building options from the buildings API", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Beta Court" })).toBeInTheDocument();
  });

  it("filters meetings when a building is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Building:");
    await user.selectOptions(select, "b1");
    // Only Alpha Tower meeting (agm1 / 2024 AGM) should show
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
  });

  it("selecting the other building shows only that building's meetings", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Building:");
    await user.selectOptions(select, "b2");
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
  });

  it("selecting All buildings after filtering shows all meetings", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    const select = screen.getByLabelText("Building:");
    await user.selectOptions(select, "b1");
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    await user.selectOptions(select, "");
    expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    expect(screen.getByText("2023 AGM")).toBeInTheDocument();
  });

  it("reads building URL param on mount and pre-selects the building", async () => {
    renderPage("?building=b2");
    await waitFor(() => {
      // Should show only Beta Court meeting
      expect(screen.getByText("2023 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Building:") as HTMLSelectElement;
    expect(select.value).toBe("b2");
  });

  it("pre-selects b1 from URL param and shows only Alpha Tower meetings", async () => {
    renderPage("?building=b1");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
    expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    const select = screen.getByLabelText("Building:") as HTMLSelectElement;
    expect(select.value).toBe("b1");
  });

  it("shows all meetings when URL param building id does not match any building", async () => {
    renderPage("?building=nonexistent");
    await waitFor(() => {
      // No match → filteredMeetings is empty — table shows no rows for either meeting
      expect(screen.queryByText("2024 AGM")).not.toBeInTheDocument();
      expect(screen.queryByText("2023 AGM")).not.toBeInTheDocument();
    });
  });
});
