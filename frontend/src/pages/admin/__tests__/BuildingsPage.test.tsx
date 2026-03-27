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
  // --- Happy path ---

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

  // --- Modal open / close ---

  it("+ New Building button is always visible (not hidden after clicking)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
  });

  it("clicking + New Building opens the modal dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByRole("dialog", { name: "New Building" })).toBeInTheDocument();
    expect(screen.getByLabelText("Building Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Manager Email")).toBeInTheDocument();
  });

  it("modal has Create Building submit button and Cancel button", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByRole("button", { name: "Create Building" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel button closes modal without submitting", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByRole("dialog", { name: "New Building" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New Building" })).not.toBeInTheDocument();
  });

  it("clicking backdrop closes modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByRole("dialog", { name: "New Building" })).toBeInTheDocument();
    // The backdrop div is the fixed overlay. In jsdom, pointer events on fixed-position
    // elements work when we target the element directly. The backdrop is the first fixed div.
    const dialog = screen.getByRole("dialog", { name: "New Building" });
    // The backdrop is the previous sibling of the dialog panel
    const backdrop = dialog.previousElementSibling as HTMLElement;
    await user.click(backdrop);
    expect(screen.queryByRole("dialog", { name: "New Building" })).not.toBeInTheDocument();
  });

  // --- Input validation ---

  it("shows error when building name is empty on submit", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    expect(screen.getByText("Building name is required.")).toBeInTheDocument();
  });

  it("shows error when manager email is empty on submit", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    await user.type(screen.getByLabelText("Building Name"), "Test Tower");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    expect(screen.getByText("Manager email is required.")).toBeInTheDocument();
  });

  // --- Happy path submit ---

  it("submits the form and closes modal on success", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    await user.type(screen.getByLabelText("Building Name"), "New Tower");
    await user.type(screen.getByLabelText("Manager Email"), "mgr@example.com");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New Building" })).not.toBeInTheDocument();
    });
  });

  // --- State / precondition errors ---

  it("shows API error inline in modal on failure", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/buildings", () => {
        return HttpResponse.json({ detail: "Building already exists" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    await user.type(screen.getByLabelText("Building Name"), "Existing Tower");
    await user.type(screen.getByLabelText("Manager Email"), "mgr@example.com");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
    // Modal stays open on error
    expect(screen.getByRole("dialog", { name: "New Building" })).toBeInTheDocument();
  });

  it("form fields are cleared when modal is closed and reopened", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    // Open modal and type something
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    await user.type(screen.getByLabelText("Building Name"), "Typed Name");
    await user.type(screen.getByLabelText("Manager Email"), "typed@example.com");
    // Close
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New Building" })).not.toBeInTheDocument();
    // Reopen — fields should be empty
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByLabelText("Building Name")).toHaveValue("");
    expect(screen.getByLabelText("Manager Email")).toHaveValue("");
  });

  // --- Show archived toggle ---

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

    // Navigate to page 2 (Active Building 21 is on page 2) — two "2" buttons exist (top + bottom)
    await user.click(screen.getAllByRole("button", { name: "2" })[0]);
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

  // --- Error state ---

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
});
