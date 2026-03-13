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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GeneralMeetingListPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("GeneralMeetingListPage", () => {
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
});
