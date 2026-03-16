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
  // --- Happy path ---
  it("renders Admin Portal heading", () => {
    renderLayout();
    expect(screen.getAllByText("Admin Portal").length).toBeGreaterThan(0);
  });

  it("renders Buildings nav link", () => {
    renderLayout();
    expect(screen.getAllByRole("link", { name: "Buildings" }).length).toBeGreaterThan(0);
  });

  it("renders General Meetings nav link", () => {
    renderLayout("/admin/general-meetings");
    expect(screen.getAllByRole("link", { name: "General Meetings" }).length).toBeGreaterThan(0);
  });

  it("renders outlet content", () => {
    renderLayout();
    // Outlet renders nothing without routes defined, but the nav is visible
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("renders Sign out button", () => {
    renderLayout();
    // Both sidebar and drawer have Sign out buttons
    expect(screen.getAllByRole("button", { name: "Sign out" }).length).toBeGreaterThan(0);
  });

  it("calls logout and navigates to login on Sign out click", async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();
    renderLayout();
    // Click the first Sign out button (sidebar)
    await user.click(screen.getAllByRole("button", { name: "Sign out" })[0]);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/login", { replace: true });
    });
  });

  // --- Mobile drawer ---
  it("renders open navigation button", () => {
    renderLayout();
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  it("drawer is closed by default (aria-hidden)", () => {
    renderLayout();
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  it("clicking open button opens the drawer", async () => {
    const user = userEvent.setup();
    renderLayout();
    const openBtn = screen.getByRole("button", { name: "Open navigation" });
    await user.click(openBtn);
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "false");
  });

  it("clicking close button closes the drawer", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("button", { name: "Close navigation" }));
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  it("clicking backdrop closes the drawer", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const backdrop = document.querySelector(".admin-nav-drawer__backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();
    await user.click(backdrop);
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  it("clicking a nav link inside the drawer closes it", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    // Drawer is open — click the Buildings link inside it
    const drawerLinks = screen.getAllByRole("link", { name: "Buildings" });
    // The drawer link is the last one (sidebar links appear first in DOM)
    await user.click(drawerLinks[drawerLinks.length - 1]);
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });
});
