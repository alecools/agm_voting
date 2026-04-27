import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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

function renderPage(initialSearch = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/buildings${initialSearch}`]}>
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

  it("loading overlay has pointer-events none while loading and auto after load", async () => {
    renderPage();
    // During loading the overlay div should block pointer events
    const loadingOverlay = screen.getByText("Loading buildings...").closest("div[style]")!;
    expect(loadingOverlay).toHaveStyle({ pointerEvents: "none" });

    // After load the overlay should allow pointer events
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    const loadedOverlay = screen.getByText("Alpha Tower").closest("div[style]")!;
    expect(loadedOverlay).toHaveStyle({ pointerEvents: "auto" });
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
      http.post("http://localhost/api/admin/buildings/import", () => {
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

  it("shows error when manager email is malformed on submit", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    await user.type(screen.getByLabelText("Building Name"), "Test Tower");
    await user.type(screen.getByLabelText("Manager Email"), "notanemail");
    await user.click(screen.getByRole("button", { name: "Create Building" }));
    expect(screen.getByText("Please enter a valid email address.")).toBeInTheDocument();
  });

  it("controls div has flexWrap wrap style for mobile wrapping", () => {
    renderPage();
    const toggle = screen.getByLabelText("Show archived");
    // The toggle is inside the controls div — walk up to the parent div
    const controlsDiv = toggle.closest("label")?.parentElement as HTMLElement;
    expect(controlsDiv).toHaveStyle({ flexWrap: "wrap" });
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
      http.post("http://localhost/api/admin/buildings", () => {
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

  it("hides archived buildings by default (server sends is_archived=false)", async () => {
    // Default handler filters by is_archived=false — Active Tower returns, Old Tower is archived and excluded
    server.use(
      http.get("http://localhost/api/admin/buildings/count", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        if (isArchivedParam === "false") {
          return HttpResponse.json({ count: 1 });
        }
        return HttpResponse.json({ count: 2 });
      }),
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        if (isArchivedParam === "false") {
          return HttpResponse.json([
            { id: "b1", name: "Active Tower", manager_email: "a@test.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
          ]);
        }
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

  it("shows archived buildings when toggle is checked (server receives no is_archived filter)", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/count", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        if (isArchivedParam === "false") {
          return HttpResponse.json({ count: 1 });
        }
        // no is_archived param → all buildings
        return HttpResponse.json({ count: 2 });
      }),
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        if (isArchivedParam === "false") {
          return HttpResponse.json([
            { id: "b1", name: "Active Tower", manager_email: "a@test.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
          ]);
        }
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
    await waitFor(() => {
      expect(screen.getByText("Old Tower")).toBeInTheDocument();
    });
    expect(screen.getByText("Active Tower")).toBeInTheDocument();
  });

  it("resets table to page 1 when Show archived filter is toggled", async () => {
    // 21 active buildings — enough for 2 pages when only active shown
    // toggling archived changes the query key, resetting to page 1
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
      http.get("http://localhost/api/admin/buildings/count", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        if (isArchivedParam === "false") {
          return HttpResponse.json({ count: 21 });
        }
        return HttpResponse.json({ count: 22 });
      }),
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const isArchivedParam = url.searchParams.get("is_archived");
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const all = isArchivedParam === "false" ? activeBuildings : [...activeBuildings, archivedBuilding];
        return HttpResponse.json(all.slice(offset, offset + limit));
      })
    );

    const user = userEvent.setup();
    renderPage();

    // Wait for page to load — Active Building 1 should be visible on page 1
    await waitFor(() => {
      expect(screen.getByText("Active Building 1")).toBeInTheDocument();
    });

    // Navigate to page 2 (Active Building 21 is on page 2)
    await user.click(screen.getAllByRole("button", { name: "Go to page 2" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Active Building 21")).toBeInTheDocument();
    });
    expect(screen.queryByText("Active Building 1")).not.toBeInTheDocument();

    // Toggle "Show archived" — query changes, page resets to 1
    await user.click(screen.getByLabelText("Show archived"));

    // Table should have reset to page 1
    await waitFor(() => {
      expect(screen.getByText("Active Building 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Active Building 21")).not.toBeInTheDocument();
  });

  // --- RR2-06: URL params for page ---

  it("renders page 1 by default (no page param in URL)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    });
    // No error — page defaults to 1
    expect(screen.queryByText("Failed to load buildings.")).not.toBeInTheDocument();
  });

  it("navigates to page 2 via pagination and updates URL param", async () => {
    const activeBuildings = Array.from({ length: 21 }, (_, i) => ({
      id: `active-${i + 1}`,
      name: `Active Building ${i + 1}`,
      manager_email: `a${i + 1}@test.com`,
      is_archived: false,
      created_at: "2024-01-01T00:00:00Z",
    }));
    server.use(
      http.get("http://localhost/api/admin/buildings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(activeBuildings.slice(offset, offset + limit));
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Active Building 1")).toBeInTheDocument();
    });
    // Click page 2 — should remove page=1 from URL (or set page=2)
    await user.click(screen.getAllByRole("button", { name: "Go to page 2" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Active Building 21")).toBeInTheDocument();
    });
    // Navigate back to page 1 via Previous button — should delete page param
    await user.click(screen.getAllByRole("button", { name: "Previous page" })[0]);
    await waitFor(() => {
      expect(screen.getByText("Active Building 1")).toBeInTheDocument();
    });
  });

  it("defaults to page 1 when page URL param is not a valid number", async () => {
    renderPage("?page=abc");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    });
    // No error — invalid page defaults to 1
    expect(screen.queryByText("Failed to load buildings.")).not.toBeInTheDocument();
  });

  it("reads page=2 from URL and loads page 2", async () => {
    const activeBuildings = Array.from({ length: 21 }, (_, i) => ({
      id: `active-${i + 1}`,
      name: `Active Building ${i + 1}`,
      manager_email: `a${i + 1}@test.com`,
      is_archived: false,
      created_at: "2024-01-01T00:00:00Z",
    }));
    server.use(
      http.get("http://localhost/api/admin/buildings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        return HttpResponse.json(activeBuildings.slice(offset, offset + limit));
      })
    );
    renderPage("?page=2");
    await waitFor(() => {
      expect(screen.getByText("Active Building 21")).toBeInTheDocument();
    });
    expect(screen.queryByText("Active Building 1")).not.toBeInTheDocument();
  });

  // --- US-ACC-02: Focus trap in New Building modal ---

  it("pressing Escape key closes the New Building modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByRole("dialog", { name: "New Building" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New Building" })).not.toBeInTheDocument();
  });

  it("Tab key wraps focus from last to first element in New Building modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    const createBtn = screen.getByRole("button", { name: "Create Building" });
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    // Tab past last focusable (Cancel) should wrap to first
    cancelBtn.focus();
    await user.tab();
    // First focusable is Building Name input
    expect(screen.getByLabelText("Building Name")).toHaveFocus();
    // Tab past Create Building (last before Cancel) wraps
    createBtn.focus();
    await user.tab();
    expect(cancelBtn).toHaveFocus();
  });

  it("Shift+Tab from first element wraps to last in New Building modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    const nameInput = screen.getByLabelText("Building Name");
    nameInput.focus();
    await user.tab({ shift: true });
    expect(cancelBtn).toHaveFocus();
  });

  it("Shift+Tab from a middle element in modal does not wrap focus", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    // Focus the Manager Email input (middle element) and Shift+Tab — should move to Building Name
    const managerEmail = screen.getByLabelText("Manager Email");
    const nameInput = screen.getByLabelText("Building Name");
    managerEmail.focus();
    await user.tab({ shift: true });
    // Focus should have moved backwards to Building Name (normal browser behaviour, not wrapped)
    expect(nameInput).toHaveFocus();
  });

  it("modal shows Required field legend", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByText(/Required field/)).toBeInTheDocument();
  });

  // --- US-ACC-08: Required field markers ---

  it("building name input in modal has aria-required=true", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByLabelText("Building Name")).toHaveAttribute("aria-required", "true");
  });

  it("manager email input in modal has aria-required=true", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "+ New Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "+ New Building" }));
    expect(screen.getByLabelText("Manager Email")).toHaveAttribute("aria-required", "true");
  });

  // --- Error state ---

  it("shows error state when fetch fails", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings", () => {
        return HttpResponse.json({ detail: "Error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load buildings.")).toBeInTheDocument();
    });
  });

  // --- Sort functionality ---

  it("renders sortable Name and Created At column headers", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Name/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Created At/ })).toBeInTheDocument();
  });

  it("Created At header shows ▼ indicator by default (desc sort)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    const createdBtn = screen.getByRole("button", { name: /Created At/ });
    expect(createdBtn.textContent).toContain("▼");
  });

  it("clicking Name header updates URL with sort_by=name&sort_dir=asc", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ }).closest("th")).toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("clicking Name header again toggles to descending", async () => {
    const user = userEvent.setup();
    renderPage("?sort_by=name&sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ }).closest("th")).toHaveAttribute("aria-sort", "descending");
    });
  });

  it("reads sort_by=name from URL and shows ascending indicator on Name", async () => {
    renderPage("?sort_by=name&sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    const nameBtn = screen.getByRole("button", { name: /Name/ });
    expect(nameBtn.closest("th")).toHaveAttribute("aria-sort", "ascending");
  });

  it("sort change resets page to 1 (sends request without page param)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("http://localhost/api/admin/buildings/count", () =>
        HttpResponse.json({ count: 21 })
      ),
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const data = Array.from({ length: 21 }, (_, i) => ({
          id: `b${i + 1}`,
          name: `Building ${i + 1}`,
          manager_email: `b${i + 1}@test.com`,
          is_archived: false,
          created_at: "2024-01-01T00:00:00Z",
        }));
        return HttpResponse.json(data.slice(offset, offset + limit));
      })
    );
    renderPage("?page=2");
    await waitFor(() => {
      expect(screen.getByText("Building 21")).toBeInTheDocument();
    });
    // Click Name to change sort — page should reset to 1
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => {
      expect(screen.getByText("Building 1")).toBeInTheDocument();
    });
    expect(screen.queryByText("Building 21")).not.toBeInTheDocument();
  });

  it("shows error state when sort_by is invalid and server returns 422", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings", () => {
        return HttpResponse.json({ detail: "Invalid sort_by value" }, { status: 422 });
      })
    );
    renderPage("?sort_by=INVALID");
    await waitFor(() => {
      expect(screen.getByText("Failed to load buildings.")).toBeInTheDocument();
    });
  });

  it("clicking same Name column while asc toggles to desc (sortDir=asc branch)", async () => {
    const user = userEvent.setup();
    // Start with name asc
    renderPage("?sort_by=name&sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ })).toBeInTheDocument();
    });
    // Click same column while asc → toggles to desc
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ }).closest("th")).toHaveAttribute("aria-sort", "descending");
    });
  });

  it("clicking same Name column while desc toggles to asc (sortDir=desc branch)", async () => {
    const user = userEvent.setup();
    // Start with name desc
    renderPage("?sort_by=name&sort_dir=desc");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ })).toBeInTheDocument();
    });
    // Click same column while desc → toggles to asc
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Name/ }).closest("th")).toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("clicking Created At from name column uses desc as default direction", async () => {
    const user = userEvent.setup();
    // Start with name active
    renderPage("?sort_by=name&sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Created At/ })).toBeInTheDocument();
    });
    // Click Created At (different column, date type → default desc)
    await user.click(screen.getByRole("button", { name: /Created At/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Created At/ }).closest("th")).toHaveAttribute("aria-sort", "descending");
    });
  });
});

// --- Fix 4: name filter input ---

describe("BuildingsPage — name filter (Fix 4)", () => {
  it("renders a 'Search buildings' label and text input", async () => {
    renderPage();
    // Input is rendered immediately as part of the page header
    expect(screen.getByLabelText("Search buildings")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter by name…")).toBeInTheDocument();
  });

  it("typing in the name filter updates the input value immediately", async () => {
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByLabelText("Search buildings");
    await user.type(input, "Tower");
    expect(input).toHaveValue("Tower");
  });

  it("name_filter URL param pre-populates the filter input on load", () => {
    renderPage("?name_filter=Alpha");
    expect(screen.getByLabelText("Search buildings")).toHaveValue("Alpha");
  });

  it("listBuildings is called with name param when name_filter is in URL", async () => {
    let capturedName: string | null = null;
    server.use(
      http.get("http://localhost/api/admin/buildings", ({ request }) => {
        const url = new URL(request.url);
        capturedName = url.searchParams.get("name");
        return HttpResponse.json([
          { id: "b1", name: "Alpha Tower", manager_email: "a@test.com", is_archived: false, created_at: "2024-01-01T00:00:00Z" },
        ]);
      }),
      http.get("http://localhost/api/admin/buildings/count", () =>
        HttpResponse.json({ count: 1 })
      )
    );
    renderPage("?name_filter=Alpha");
    await waitFor(() => {
      expect(capturedName).toBe("Alpha");
    });
  });

  it("after debounce fires, name_filter URL param is updated", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    const input = screen.getByLabelText("Search buildings");
    await user.type(input, "To");
    expect(input).toHaveValue("To");
    vi.runAllTimers();
    await waitFor(() => {
      expect(input).toHaveValue("To");
    });
    vi.useRealTimers();
  }, 10000);

  it("clearing the filter value triggers the empty-string branch (delete name_filter)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage("?name_filter=Tower");
    await waitFor(() => {
      expect(screen.getByLabelText("Search buildings")).toHaveValue("Tower");
    });
    await user.clear(screen.getByLabelText("Search buildings"));
    expect(screen.getByLabelText("Search buildings")).toHaveValue("");
    vi.runAllTimers();
    await waitFor(() => {
      expect(screen.getByLabelText("Search buildings")).toHaveValue("");
    });
    vi.useRealTimers();
  }, 10000);

  it("typing clears any existing debounce timeout (debounceRef.current branch)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPage();
    const input = screen.getByLabelText("Search buildings");
    await user.type(input, "A");
    vi.advanceTimersByTime(100);
    await user.type(input, "l");
    expect(input).toHaveValue("Al");
    vi.runAllTimers();
    await waitFor(() => {
      expect(input).toHaveValue("Al");
    });
    vi.useRealTimers();
  }, 10000);
});
