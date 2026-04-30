import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AdminLoginPage from "../AdminLoginPage";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";
import type { TenantConfig } from "../../../api/config";

// Use vi.hoisted() so mock functions are available inside the hoisted vi.mock() factories.
const { mockNavigate, mockSignInEmail } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSignInEmail: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the Better Auth client so tests don't make real network calls.
vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: mockSignInEmail,
    },
  },
}));

function renderPage(config: TenantConfig = DEFAULT_CONFIG) {
  return render(
    <BrandingContext.Provider value={{ config, isLoading: false }}>
      <MemoryRouter>
        <AdminLoginPage />
      </MemoryRouter>
    </BrandingContext.Provider>
  );
}

describe("AdminLoginPage", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSignInEmail.mockClear();
  });

  // --- Happy path ---

  it("renders email and password fields", () => {
    renderPage();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("renders Sign in button", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("navigates to /admin on successful sign-in", async () => {
    mockSignInEmail.mockResolvedValueOnce({ data: { user: { email: "admin@example.com" } }, error: null });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  it("calls signIn.email with the entered email and password", async () => {
    mockSignInEmail.mockResolvedValueOnce({ data: { user: {} }, error: null });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "secret123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: "admin@example.com",
        password: "secret123",
      });
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
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows correct app_name text when logo_url is empty", () => {
    renderPage({ ...DEFAULT_CONFIG, logo_url: "", app_name: "Corp Vote" });
    expect(screen.getByText("Corp Vote")).toBeInTheDocument();
    expect(screen.getByText("Corp Vote")).toHaveClass("admin-login-card__app-name");
  });

  // --- Input validation / error states ---

  it("shows error message when signIn.email returns an error object", async () => {
    mockSignInEmail.mockResolvedValueOnce({ data: null, error: { message: "Invalid credentials" } });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Invalid email or password.")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("shows error message when signIn.email throws", async () => {
    mockSignInEmail.mockRejectedValueOnce(new Error("Network error"));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "bad");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Invalid email or password.")).toBeInTheDocument();
  });

  // --- Async UI transitions ---

  it("shows Signing in… while the sign-in call is pending", async () => {
    let resolve!: (value: { data: unknown; error: null }) => void;
    mockSignInEmail.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // While pending: shows "Signing in…" and navigate has NOT been called
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    // Complete the sign-in
    resolve({ data: { user: {} }, error: null });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  it("disables submit button while loading", async () => {
    let resolve!: (value: { data: unknown; error: null }) => void;
    mockSignInEmail.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    resolve({ data: { user: {} }, error: null });
  });

  // --- Navigation ---

  it("renders Back to home button", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "← Back to home" })).toBeInTheDocument();
  });

  it("navigates to / when Back to home is clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "← Back to home" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });
});
