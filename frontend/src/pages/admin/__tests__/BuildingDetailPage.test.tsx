import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function renderPage(buildingId = "b1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/buildings/${buildingId}`]}>
        <Routes>
          <Route path="/admin/buildings/:buildingId" element={<BuildingDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("BuildingDetailPage", () => {
  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading lot owners...")).toBeInTheDocument();
  });

  it("renders lot owner table after loading", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("1A")).toBeInTheDocument();
    });
    expect(screen.getByText("owner1@example.com")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => {
      expect(screen.getByText(/Import complete: 5 records imported/)).toBeInTheDocument();
    });
  });

  it("shows error state when lot owners fetch fails", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/buildings/:buildingId/lot-owners", () => {
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

  it("shows Building label when building not found in cache", async () => {
    renderPage("b-unknown");
    await waitFor(() => {
      expect(screen.getByText("Building")).toBeInTheDocument();
    });
  });

  it("shows Create AGM button", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create AGM" })).toBeInTheDocument();
    });
  });

  it("navigates to /admin/agms/new when Create AGM clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create AGM" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Create AGM" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/agms/new");
  });

});
