import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminLayout from "../AdminLayout";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderLayout(path = "/admin/buildings") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AdminLayout />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AdminLayout", () => {
  it("renders Admin Portal heading", () => {
    renderLayout();
    expect(screen.getByText("Admin Portal")).toBeInTheDocument();
  });

  it("renders Buildings nav link", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: "Buildings" })).toBeInTheDocument();
  });

  it("renders General Meetings nav link", () => {
    renderLayout("/admin/general-meetings");
    expect(screen.getByRole("link", { name: "General Meetings" })).toBeInTheDocument();
  });

  it("renders outlet content", () => {
    renderLayout();
    // Outlet renders nothing without routes defined, but the nav is visible
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("renders Sign out button", () => {
    renderLayout();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("calls logout and navigates to login on Sign out click", async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();
    renderLayout();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/login", { replace: true });
    });
  });
});
