import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import AdminLoginPage from "../AdminLoginPage";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";
import type { TenantConfig } from "../../../api/config";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(config: TenantConfig = DEFAULT_CONFIG) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <BrandingContext.Provider value={{ config, isLoading: false }}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AdminLoginPage />
        </MemoryRouter>
      </QueryClientProvider>
    </BrandingContext.Provider>
  );
}

describe("AdminLoginPage", () => {
  // --- Happy path ---

  it("renders username and password fields", () => {
    renderPage();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("renders Sign in button", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("navigates to /admin on successful login", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "admin");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  // --- Branding: logo rendering ---

  it("renders dynamic logo img when logo_url is set", () => {
    renderPage({ ...DEFAULT_CONFIG, logo_url: "https://example.com/custom-logo.png", app_name: "My AGM" });
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://example.com/custom-logo.png");
    expect(img).toHaveAttribute("alt", "My AGM");
    expect(img).toHaveClass("admin-login-card__logo");
  });

  it("shows app name text when logo_url is empty (no broken image)", () => {
    renderPage({ ...DEFAULT_CONFIG, logo_url: "", app_name: "AGM Voting" });
    expect(screen.getByText("AGM Voting")).toBeInTheDocument();
    expect(screen.getByText("AGM Voting")).toHaveClass("admin-login-card__app-name");
    // No fallback img element with a broken /logo.png src
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows correct app_name text when logo_url is empty", () => {
    renderPage({ ...DEFAULT_CONFIG, logo_url: "", app_name: "Corp Vote" });
    expect(screen.getByText("Corp Vote")).toBeInTheDocument();
    expect(screen.getByText("Corp Vote")).toHaveClass("admin-login-card__app-name");
  });

  // --- Input validation ---

  it("shows error message on invalid credentials", async () => {
    server.use(
      http.post("http://localhost/api/admin/auth/login", () => {
        return HttpResponse.json({ detail: "Invalid credentials" }, { status: 401 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Username"), "wrong");
    await user.type(screen.getByLabelText("Password"), "bad");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Invalid username or password.")).toBeInTheDocument();
  });

  // --- State / precondition errors ---

  it("shows Signing in… while loading", async () => {
    let resolve!: (value: Response) => void;
    server.use(
      http.post("http://localhost/api/admin/auth/login", () => {
        return new Promise((res) => { resolve = res as (value: Response) => void; });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "admin");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeInTheDocument();
    resolve(HttpResponse.json({ ok: true }) as unknown as Response);
  });

  it("disables submit button while loading", async () => {
    let resolve!: (value: Response) => void;
    server.use(
      http.post("http://localhost/api/admin/auth/login", () => {
        return new Promise((res) => { resolve = res as (value: Response) => void; });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "admin");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    resolve(HttpResponse.json({ ok: true }) as unknown as Response);
  });

  // --- Navigation ---

  it("renders Back to home button", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "← Back to home" })).toBeInTheDocument();
  });

  it("navigates to / when Back to home is clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "← Back to home" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });
});
