import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import AdminLayout from "../AdminLayout";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";

const BASE = "http://localhost";

// Use vi.hoisted() so mock functions are available inside the hoisted vi.mock() factories.
const { mockSignOut, mockNavigate } = vi.hoisted(() => ({
  mockSignOut: vi.fn().mockResolvedValue(undefined),
  mockNavigate: vi.fn(),
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    signOut: mockSignOut,
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderLayout(path = "/admin/buildings", logoUrl = "", appName = "General Meeting") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const effectiveLogoUrl = logoUrl || DEFAULT_CONFIG.logo_url;
  return render(
    <BrandingContext.Provider value={{ config: { ...DEFAULT_CONFIG, logo_url: logoUrl, app_name: appName }, isLoading: false, effectiveLogoUrl, effectiveFaviconUrl: DEFAULT_CONFIG.favicon_url || "" }}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <AdminLayout />
        </MemoryRouter>
      </QueryClientProvider>
    </BrandingContext.Provider>
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

  it("all Sign out buttons have explicit rgba white colour (not inherit)", () => {
    renderLayout();
    const signOutButtons = screen.getAllByRole("button", { name: "Sign out" });
    for (const btn of signOutButtons) {
      expect(btn).toHaveStyle({ color: "rgba(255,255,255,.85)" });
    }
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

  // --- US-ACC-06: Escape key closes drawer ---

  it("pressing Escape key closes the drawer when open", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "false");
    await user.keyboard("{Escape}");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  it("pressing Escape when drawer is closed has no effect", async () => {
    const user = userEvent.setup();
    renderLayout();
    // Drawer starts closed
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    // Pressing Escape should not error or change state
    await user.keyboard("{Escape}");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  // --- US-ACC-07: Skip link ---

  it("renders skip-to-main-content link as first focusable element", () => {
    renderLayout();
    const skip = document.querySelector(".skip-link") as HTMLElement;
    expect(skip).toBeTruthy();
    expect(skip.getAttribute("href")).toBe("#main-content");
    expect(skip.textContent).toBe("Skip to main content");
  });

  it("main content area has id=main-content", () => {
    renderLayout();
    expect(document.getElementById("main-content")).toBeInTheDocument();
  });

  // --- Settings nav link ---

  it("renders Settings nav link", () => {
    renderLayout();
    expect(screen.getAllByRole("link", { name: "Settings" }).length).toBeGreaterThan(0);
  });

  it("Settings link has active class when on settings path", () => {
    // Covers the active class branch on the Settings NavLink (line 38)
    renderLayout("/admin/settings");
    const settingsLinks = screen.getAllByRole("link", { name: "Settings" });
    const activeLink = settingsLinks.find((l) => l.classList.contains("admin-nav__link--active"));
    expect(activeLink).toBeTruthy();
  });

  // --- Branding: logo rendering (Fix 11: always renders img with effectiveLogoUrl) ---

  it("renders app name text span when logo_url is empty", () => {
    // When logo_url is empty, the OCSS fallback img is still rendered (Fix 11),
    // and the .admin-sidebar__app-name span is also rendered with the app name text.
    renderLayout("/admin/buildings", "", "My AGM");
    const imgs = screen.getAllByRole("img");
    expect(imgs.length).toBeGreaterThan(0);
    // img uses the OCSS fallback logo URL, alt is set to app name
    expect(imgs[0]).toHaveAttribute("alt", "My AGM");
    // App name span is rendered when logo_url is empty
    const appNameSpans = document.querySelectorAll(".admin-sidebar__app-name");
    expect(appNameSpans.length).toBeGreaterThan(0);
    expect(appNameSpans[0]).toHaveTextContent("My AGM");
  });

  it("renders logo img when logo_url is set and does not render app name span", () => {
    renderLayout("/admin/buildings", "https://example.com/logo.png", "My AGM");
    const imgs = screen.getAllByRole("img");
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[0]).toHaveAttribute("src", "https://example.com/logo.png");
    expect(imgs[0]).toHaveAttribute("alt", "My AGM");
    // App name span is hidden when logo_url is set — logo takes its place
    expect(document.querySelectorAll(".admin-sidebar__app-name").length).toBe(0);
  });

  // --- SMTP unconfigured banner ---

  it("shows SMTP unconfigured banner when status is false", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp/status`, () =>
        HttpResponse.json({ configured: false })
      )
    );
    renderLayout();
    await waitFor(() =>
      expect(screen.getByText(/Mail server not configured/)).toBeInTheDocument()
    );
  });

  it("does not show SMTP banner when status is true", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp/status`, () =>
        HttpResponse.json({ configured: true })
      )
    );
    renderLayout();
    await waitFor(() => expect(screen.getByRole("navigation")).toBeInTheDocument());
    expect(screen.queryByText(/Mail server not configured/)).not.toBeInTheDocument();
  });

  it("dismisses SMTP banner on close button click", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp/status`, () =>
        HttpResponse.json({ configured: false })
      )
    );
    const user = userEvent.setup();
    renderLayout();
    await waitFor(() =>
      expect(screen.getByText(/Mail server not configured/)).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Dismiss SMTP warning" }));
    expect(screen.queryByText(/Mail server not configured/)).not.toBeInTheDocument();
  });

  it("does not show SMTP banner when status fetch fails", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp/status`, () =>
        HttpResponse.json({ detail: "error" }, { status: 500 })
      )
    );
    renderLayout();
    await waitFor(() => expect(screen.getByRole("navigation")).toBeInTheDocument());
    expect(screen.queryByText(/Mail server not configured/)).not.toBeInTheDocument();
  });

  it("Sign out button in mobile drawer navigates to login", async () => {
    // Covers the Sign out button inside the drawer (line 143 in AdminLayout)
    const user = userEvent.setup();
    mockNavigate.mockClear();
    renderLayout();
    // Open the drawer first
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    // The drawer Sign out button is the second "Sign out" button in the DOM
    const signOutButtons = screen.getAllByRole("button", { name: "Sign out" });
    expect(signOutButtons.length).toBeGreaterThanOrEqual(2);
    await user.click(signOutButtons[signOutButtons.length - 1]);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin/login", { replace: true });
    });
  });
});
