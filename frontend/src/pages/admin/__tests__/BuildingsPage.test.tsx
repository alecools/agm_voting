import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import BuildingsPage from "../BuildingsPage";

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
        <BuildingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("BuildingsPage", () => {
  it("shows loading state inline in table while page header remains visible", () => {
    renderPage();
    // Page structure renders immediately
    expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    // Loading message is inside the table body
    expect(screen.getByText("Loading buildings...")).toBeInTheDocument();
  });

  it("renders building table after loading", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta Court")).toBeInTheDocument();
  });

  it("shows error state when fetch fails", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/buildings", () => {
        return HttpResponse.json({ detail: "Error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load buildings.")).toBeInTheDocument();
    });
  });

  it("renders CSV upload section", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.getByText("Import Buildings")).toBeInTheDocument();
  });

  it("navigates to building detail on name click", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Alpha Tower" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Alpha Tower" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/buildings/b1");
  });

  it("shows success message after CSV upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Buildings file")).toBeInTheDocument();
    });
    const file = new File(["building_name,manager_email\nTest,t@t.com"], "buildings.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Buildings file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 2 created, 1 updated/)).toBeInTheDocument();
    });
  });

  it("shows error after failed CSV upload", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings/import", () => {
        return HttpResponse.json({ detail: "Bad CSV" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Buildings file")).toBeInTheDocument();
    });
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Buildings file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });

  it("shows create building form when + New Building clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByRole("heading", { name: "Create Building" })).toBeInTheDocument();
  });

  it("hides archived buildings by default", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/buildings", () => {
        return HttpResponse.json([
          { id: "b1", name: "Active Tower", manager_email: "a@test.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
          { id: "b2", name: "Old Tower", manager_email: "o@test.com", is_archived: true, created_at: "2023-01-01T00:00:00Z" },
        ]);
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Active Tower")).toBeInTheDocument();
    });
    expect(screen.queryByText("Old Tower")).not.toBeInTheDocument();
  });

  it("shows archived buildings when toggle is checked", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/buildings", () => {
        return HttpResponse.json([
          { id: "b1", name: "Active Tower", manager_email: "a@test.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
          { id: "b2", name: "Old Tower", manager_email: "o@test.com", is_archived: true, created_at: "2023-01-01T00:00:00Z" },
        ]);
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Active Tower")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Show archived"));
    expect(screen.getByText("Old Tower")).toBeInTheDocument();
    expect(screen.getByText("Active Tower")).toBeInTheDocument();
  });

  it("resets table to page 1 when Show archived filter is toggled", async () => {
    // 21 active buildings + 1 archived — enough for 2 pages when only active shown (21 active)
    // and also enough for 2 pages when all shown (22 total)
    const activeBuildings = Array.from({ length: 21 }, (_, i) => ({
      id: `active-${i + 1}`,
      name: `Active Building ${i + 1}`,
      manager_email: `a${i + 1}@test.com`,
      is_archived: false,
      created_at: "2024-01-01T00:00:00Z",
    }));
    const archivedBuilding = {
      id: "archived-1",
      name: "Archived Building 1",
      manager_email: "arch@test.com",
      is_archived: true,
      created_at: "2023-01-01T00:00:00Z",
    };
    server.use(
      http.get("http://localhost:8000/api/admin/buildings", () => {
        return HttpResponse.json([...activeBuildings, archivedBuilding]);
      })
    );

    const user = userEvent.setup();
    renderPage();

    // Wait for page to load — Active Building 1 should be visible on page 1
    await waitFor(() => {
      expect(screen.getByText("Active Building 1")).toBeInTheDocument();
    });

    // Navigate to page 2 (Active Building 21 is on page 2)
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Active Building 21")).toBeInTheDocument();
    expect(screen.queryByText("Active Building 1")).not.toBeInTheDocument();

    // Toggle "Show archived" — visibleBuildings length changes (21 → 22)
    await user.click(screen.getByLabelText("Show archived"));

    // Table should have reset to page 1
    await waitFor(() => {
      expect(screen.getByText("Active Building 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Active Building 21")).not.toBeInTheDocument();
  });
});
