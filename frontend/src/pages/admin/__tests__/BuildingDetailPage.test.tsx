import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import BuildingDetailPage from "../BuildingDetailPage";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(buildingId = "b1", search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/buildings/${buildingId}${search}`]}>
        <Routes>
          <Route path="/admin/buildings/:buildingId" element={<BuildingDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("BuildingDetailPage", () => {
  it("shows loading state inline in table while page header remains visible", () => {
    renderPage();
    // Page structure renders immediately
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Lot Owner" })).toBeInTheDocument();
    // Loading message is inside the table body
    expect(screen.getByText("Loading lot owners...")).toBeInTheDocument();
  });

  it("renders lot owner table after loading", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("1A")).toBeInTheDocument();
    });
    // Email column now shows "Name <email>" when owner name is present
    expect(screen.getByText("Alice Smith <owner1@example.com>")).toBeInTheDocument();
    expect(screen.getByText("2B")).toBeInTheDocument();
  });

  it("shows building name when building is found", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
  });

  it("shows Add Lot Owner button", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Lot Owner" })).toBeInTheDocument();
    });
  });

  it("shows add form when Add Lot Owner clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Lot Owner" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    expect(screen.getByRole("heading", { name: "Add Lot Owner" })).toBeInTheDocument();
  });

  it("shows edit form when Edit clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Edit" })[0]).toBeInTheDocument();
    });
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByRole("heading", { name: "Edit Lot Owner" })).toBeInTheDocument();
  });

  it("hides form when Cancel clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add Lot Owner" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add Lot Owner" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Add Lot Owner" })).not.toBeInTheDocument();
  });

  it("shows 409 error when adding duplicate lot number", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Add Lot Owner" })[0]).toBeInTheDocument();
    });
    // Click the first "Add Lot Owner" button (the page-level one)
    await user.click(screen.getAllByRole("button", { name: "Add Lot Owner" })[0]);
    await user.type(screen.getByLabelText("Lot Number"), "DUPLICATE");
    await user.type(screen.getByLabelText("Email"), "d@d.com");
    await user.type(screen.getByLabelText("Unit Entitlement"), "100");
    // Now click the form submit button
    const addButtons = screen.getAllByRole("button", { name: "Add Lot Owner" });
    await user.click(addButtons[addButtons.length - 1]);
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  it("shows success after CSV upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Lot owners file")).toBeInTheDocument();
    });
    const file = new File(["lot_number,email,unit_entitlement\n1A,a@a.com,100"], "owners.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Lot owners file"), file);
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 5 records imported/)).toBeInTheDocument();
    });
  });

  it("shows error state when lot owners fetch fails", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners", () => {
        return HttpResponse.json({ detail: "Error" }, { status: 500 });
      })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load lot owners.")).toBeInTheDocument();
    });
  });

  it("hides add form after successful add", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Add Lot Owner" })[0]).toBeInTheDocument();
    });
    await user.click(screen.getAllByRole("button", { name: "Add Lot Owner" })[0]);
    await user.type(screen.getByLabelText("Lot Number"), "5E");
    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.type(screen.getByLabelText("Unit Entitlement"), "50");
    const addButtons = screen.getAllByRole("button", { name: "Add Lot Owner" });
    await user.click(addButtons[addButtons.length - 1]);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Add Lot Owner" })).not.toBeInTheDocument();
    });
  });

  it("shows Building label when building is not found", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({ detail: "Building not found" }, { status: 404 });
      })
    );
    renderPage("b-unknown");
    await waitFor(() => {
      expect(screen.getByText("Building")).toBeInTheDocument();
    });
  });

  it("shows Create General Meeting button", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create General Meeting" })).toBeInTheDocument();
    });
  });

  it("navigates to /admin/general-meetings/new when Create General Meeting clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create General Meeting" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Create General Meeting" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings/new");
  });

  it("shows Archive Building button for active buildings", async () => {
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
  });

  it("opens archive confirm modal when Archive Building clicked", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    expect(screen.getByRole("dialog", { name: "Archive Building" })).toBeInTheDocument();
    expect(screen.getByText(/Archived buildings will no longer appear/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows building name in archive modal heading", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    expect(screen.getByRole("heading", { level: 2, name: /Alpha Tower/ })).toBeInTheDocument();
  });

  it("closes archive modal on Cancel without archiving", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    expect(screen.getByRole("dialog", { name: "Archive Building" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Archive Building" })).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/buildings");
  });

  it("archives building and navigates away when Archive confirmed", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/buildings");
    });
  });

  it("shows archive error when API fails", async () => {
    server.use(
      http.post("http://localhost/api/admin/buildings/:buildingId/archive", () => {
        return HttpResponse.json({ detail: "Already archived" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => {
      expect(screen.getByText(/Already archived/i)).toBeInTheDocument();
    });
  });

  it("shows Import Proxy Nominations upload section", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Proxy nominations file")).toBeInTheDocument();
    });
  });

  it("shows success after proxy nominations upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Proxy nominations file")).toBeInTheDocument();
    });
    const file = new File(["Lot#,Proxy Email\n1A,proxy@test.com"], "proxies.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    await waitFor(() => {
      expect(screen.getByText(/3 upserted/)).toBeInTheDocument();
    });
  });

  it("shows error when proxy nominations upload fails", async () => {
    server.use(
      http.post("http://localhost/api/admin/buildings/:buildingId/lot-owners/import-proxies", () => {
        return HttpResponse.json({ detail: "Missing required CSV headers" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Proxy nominations file")).toBeInTheDocument();
    });
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Proxy nominations file"), file);
    await waitFor(() => {
      expect(screen.getAllByText(/Error:/).length).toBeGreaterThan(0);
    });
  });

  it("shows Import Financial Positions upload section", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Financial positions file")).toBeInTheDocument();
    });
  });

  it("shows success after financial positions upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Financial positions file")).toBeInTheDocument();
    });
    const file = new File(["Lot#,Financial Position\n1A,Normal"], "fp.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    await waitFor(() => {
      expect(screen.getByText(/4 updated/)).toBeInTheDocument();
    });
  });

  it("shows error when financial positions upload fails", async () => {
    server.use(
      http.post("http://localhost/api/admin/buildings/:buildingId/lot-owners/import-financial-positions", () => {
        return HttpResponse.json({ detail: "Invalid value" }, { status: 422 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Financial positions file")).toBeInTheDocument();
    });
    const file = new File(["bad"], "bad.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Financial positions file"), file);
    await waitFor(() => {
      expect(screen.getAllByText(/Error:/).length).toBeGreaterThan(0);
    });
  });

  it("does not show Archive Building button for archived buildings", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Archive Building" })).not.toBeInTheDocument();
  });

  it("renders back button", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
  });

  it("clicking back navigates to /admin/buildings", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/buildings");
  });

  // --- Edit Building modal ---

  it("shows Edit Building button when building is found", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
  });

  it("does not show Edit Building button when building is not found", async () => {
    renderPage("b-unknown");
    await waitFor(() => {
      expect(screen.getByText("Building")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Edit Building" })).not.toBeInTheDocument();
  });

  it("opens edit modal when Edit Building clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    expect(screen.getByRole("heading", { name: "Edit Building" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Alpha Tower");
    expect(screen.getByLabelText("Manager Email")).toHaveValue("alpha@example.com");
  });

  it("closes modal on Cancel without saving", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    expect(screen.getByRole("heading", { name: "Edit Building" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Edit Building" })).not.toBeInTheDocument();
  });

  it("shows 'No changes detected' when neither field changed", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.getByText("No changes detected")).toBeInTheDocument();
    });
  });

  it("submits with updated name only and closes modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated Tower");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit Building" })).not.toBeInTheDocument();
    });
  });

  it("submits with updated manager email only and closes modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    const emailInput = screen.getByLabelText("Manager Email");
    await user.clear(emailInput);
    await user.type(emailInput, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit Building" })).not.toBeInTheDocument();
    });
  });

  it("shows server error when PATCH fails", async () => {
    server.use(
      http.patch("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({ detail: "Name already taken" }, { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Duplicate Tower");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  // --- Delete Building ---

  it("shows Delete Building button only for archived buildings", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
  });

  it("does not show Delete Building button for active buildings", async () => {
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByText("Alpha Tower")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Delete Building" })).not.toBeInTheDocument();
  });

  it("opens delete confirm modal when Delete Building clicked", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    expect(screen.getByRole("dialog", { name: "Delete Building" })).toBeInTheDocument();
    expect(screen.getByText(/This action cannot be undone/)).toBeInTheDocument();
  });

  it("shows building name in delete modal heading", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    expect(screen.getByRole("heading", { level: 2, name: /Alpha Tower/ })).toBeInTheDocument();
  });

  it("closes delete modal on Cancel without deleting", async () => {
    mockNavigate.mockClear();
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    expect(screen.getByRole("dialog", { name: "Delete Building" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete Building" })).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/buildings");
  });

  it("closes delete modal on Escape without deleting", async () => {
    mockNavigate.mockClear();
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    expect(screen.getByRole("dialog", { name: "Delete Building" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete Building" })).not.toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/buildings");
  });

  it("closes delete modal on backdrop click without deleting", async () => {
    mockNavigate.mockClear();
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Building" });
    expect(dialog).toBeInTheDocument();
    await user.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Delete Building" })).not.toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalledWith("/admin/buildings");
  });

  it("navigates to buildings list on successful delete", async () => {
    mockNavigate.mockClear();
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      }),
      http.delete("http://localhost/api/admin/buildings/:buildingId", () => {
        return new HttpResponse(null, { status: 204 });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Building" });
    await user.click(within(dialog).getByRole("button", { name: "Delete Building" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/buildings");
    });
  });

  it("shows delete error when API returns error", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      }),
      http.delete("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json(
          { detail: "Only archived buildings can be deleted" },
          { status: 409 }
        );
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Building" });
    await user.click(within(dialog).getByRole("button", { name: "Delete Building" }));
    await waitFor(() => {
      expect(screen.getByText(/409/)).toBeInTheDocument();
    });
  });

  // --- RR3-07: ArchiveConfirmModal focus trap + Escape ---

  it("ArchiveConfirmModal focuses first element (Cancel button) when opened", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("ArchiveConfirmModal closes on Escape key", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    expect(screen.getByRole("dialog", { name: "Archive Building" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Archive Building" })).not.toBeInTheDocument();
    });
  });

  it("ArchiveConfirmModal wraps Tab from last button back to first", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    const archiveBtn = screen.getByRole("button", { name: "Archive" });
    archiveBtn.focus();
    await user.tab();
    expect(cancelBtn).toHaveFocus();
  });

  it("ArchiveConfirmModal wraps Shift+Tab from first button to last", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Archive Building" }));
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    const archiveBtn = screen.getByRole("button", { name: "Archive" });
    cancelBtn.focus();
    await user.tab({ shift: true });
    expect(archiveBtn).toHaveFocus();
  });

  // --- RR3-07: BuildingEditModal focus trap + Escape ---

  it("BuildingEditModal focuses first focusable element when opened", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    // First focusable element is the Name input
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("BuildingEditModal closes on Escape key when not saving", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    expect(screen.getByRole("dialog", { name: "Edit Building" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Edit Building" })).not.toBeInTheDocument();
    });
  });

  it("BuildingEditModal wraps Tab from last button back to first focusable", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    const nameInput = screen.getByLabelText("Name");
    const saveBtn = screen.getByRole("button", { name: "Save Changes" });
    saveBtn.focus();
    await user.tab();
    expect(nameInput).toHaveFocus();
  });

  it("BuildingEditModal wraps Shift+Tab from first focusable to last", async () => {
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Edit Building" }));
    const nameInput = screen.getByLabelText("Name");
    const saveBtn = screen.getByRole("button", { name: "Save Changes" });
    nameInput.focus();
    await user.tab({ shift: true });
    expect(saveBtn).toHaveFocus();
  });

  // --- RR6: DeleteBuildingConfirmModal focus trap + Escape ---

  it("DeleteBuildingConfirmModal focuses first element (Cancel button) when opened", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("DeleteBuildingConfirmModal wraps Tab from last button back to first", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Building" });
    const cancelBtn = within(dialog).getByRole("button", { name: "Cancel" });
    const deleteBtn = within(dialog).getByRole("button", { name: "Delete Building" });
    deleteBtn.focus();
    await user.tab();
    expect(cancelBtn).toHaveFocus();
  });

  it("DeleteBuildingConfirmModal wraps Shift+Tab from first button to last", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Delete Building" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Building" });
    const cancelBtn = within(dialog).getByRole("button", { name: "Cancel" });
    const deleteBtn = within(dialog).getByRole("button", { name: "Delete Building" });
    cancelBtn.focus();
    await user.tab({ shift: true });
    expect(deleteBtn).toHaveFocus();
  });

  it("Delete Building button uses btn--danger class", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId", () => {
        return HttpResponse.json({
          id: "b1",
          name: "Alpha Tower",
          manager_email: "alpha@example.com",
          is_archived: true,
          created_at: "2024-01-01T00:00:00Z",
        });
      })
    );
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete Building" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Delete Building" })).toHaveClass("btn--danger");
  });

  // --- Pagination ---

  it("does not show pagination when total count is 2 (≤ PAGE_SIZE=20)", async () => {
    // Default MSW: ADMIN_LOT_OWNERS has 2 items for b1, count = 2
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getByText("1A")).toBeInTheDocument();
    });
    // Pagination nav only renders when totalPages > 1; with 2 items it stays hidden
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
  });

  it("shows pagination nav when count exceeds PAGE_SIZE", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners/count", () =>
        HttpResponse.json({ count: 25 })
      )
    );
    renderPage("b1");
    await waitFor(() => {
      const navs = screen.getAllByRole("navigation", { name: "Pagination" });
      expect(navs.length).toBeGreaterThan(0);
    });
  });

  it("passes lotPage=2 URL param when navigating to page 2", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners/count", () =>
        HttpResponse.json({ count: 25 })
      )
    );
    const user = userEvent.setup();
    renderPage("b1");
    await waitFor(() => {
      expect(screen.getAllByRole("navigation", { name: "Pagination" }).length).toBeGreaterThan(0);
    });
    await user.click(screen.getAllByRole("button", { name: "Go to page 2" })[0]);
    // After clicking page 2, the Pagination component should show page 2 as active
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Go to page 2" })[0]).toHaveClass("pagination__btn--active");
    });
  });

  it("prefetches next page when there are more items than PAGE_SIZE", async () => {
    let prefetchCalled = false;
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners/count", () =>
        HttpResponse.json({ count: 25 })
      ),
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners", ({ request }) => {
        const url = new URL(request.url);
        const offset = url.searchParams.get("offset");
        if (offset === "20") prefetchCalled = true;
        return HttpResponse.json([]);
      })
    );
    renderPage("b1");
    await waitFor(() => {
      expect(prefetchCalled).toBe(true);
    });
  });

  it("reads lotPage from URL search param", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners/count", () =>
        HttpResponse.json({ count: 25 })
      )
    );
    renderPage("b1", "?lotPage=2");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Go to page 2" })[0]).toHaveClass("pagination__btn--active");
    });
  });

  it("navigates back to page 1 removing lotPage param", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners/count", () =>
        HttpResponse.json({ count: 25 })
      )
    );
    const user = userEvent.setup();
    renderPage("b1", "?lotPage=2");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Go to page 1" })[0]).toBeInTheDocument();
    });
    await user.click(screen.getAllByRole("button", { name: "Go to page 1" })[0]);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Go to page 1" })[0]).toHaveClass("pagination__btn--active");
    });
  });

  // --- Server-side sort: URL params passed to API ---

  it("passes lot_sort_by and lot_sort_dir from URL to listLotOwners query", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    renderPage("b1", "?lot_sort_by=unit_entitlement&lot_sort_dir=desc");
    await waitFor(() => {
      expect(capturedUrl).not.toBeNull();
    });
    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("sort_by")).toBe("unit_entitlement");
    expect(url.searchParams.get("sort_dir")).toBe("desc");
  });

  it("defaults to lot_sort_by=lot_number and lot_sort_dir=asc when no URL params present", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      })
    );
    renderPage("b1");
    await waitFor(() => {
      expect(capturedUrl).not.toBeNull();
    });
    const url = new URL(capturedUrl!);
    expect(url.searchParams.get("sort_by")).toBe("lot_number");
    expect(url.searchParams.get("sort_dir")).toBe("asc");
  });

  it("clicking Lot Number sort column updates lot_sort_by and lot_sort_dir URL params", async () => {
    const user = userEvent.setup();
    renderPage("b1", "?lot_sort_by=unit_entitlement&lot_sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByText("1A")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Lot Number/ }));
    await waitFor(() => {
      // After clicking Lot Number (a new column), dir defaults to asc
      expect(screen.getByRole("button", { name: /Lot Number/ }).closest("th"))
        .toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("clicking active sort column toggles direction from asc to desc", async () => {
    const user = userEvent.setup();
    renderPage("b1", "?lot_sort_by=lot_number&lot_sort_dir=asc");
    await waitFor(() => {
      expect(screen.getByText("1A")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Lot Number/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Lot Number/ }).closest("th"))
        .toHaveAttribute("aria-sort", "descending");
    });
  });

  it("clicking active sort column in desc toggles to asc", async () => {
    const user = userEvent.setup();
    renderPage("b1", "?lot_sort_by=lot_number&lot_sort_dir=desc");
    await waitFor(() => {
      expect(screen.getByText("1A")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Lot Number/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Lot Number/ }).closest("th"))
        .toHaveAttribute("aria-sort", "ascending");
    });
  });

  it("sort change resets lotPage param to 1", async () => {
    server.use(
      http.get("http://localhost/api/admin/buildings/:buildingId/lot-owners/count", () =>
        HttpResponse.json({ count: 25 })
      )
    );
    const user = userEvent.setup();
    renderPage("b1", "?lotPage=2&lot_sort_by=lot_number&lot_sort_dir=asc");
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Go to page 2" })[0]).toHaveClass("pagination__btn--active");
    });
    await user.click(screen.getByRole("button", { name: /Unit Entitlement/ }));
    await waitFor(() => {
      // Page should reset to 1
      expect(screen.getAllByRole("button", { name: "Go to page 1" })[0]).toHaveClass("pagination__btn--active");
    });
  });
});
