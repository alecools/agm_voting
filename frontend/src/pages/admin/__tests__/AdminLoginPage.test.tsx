import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AdminLoginPage from "../AdminLoginPage";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";
import type { TenantConfig } from "../../../api/config";

// Use vi.hoisted() so mock functions are available inside the hoisted vi.mock() factories.
const { mockNavigate, mockFetch, mockGetSession, mockForgetPassword, mockResetPassword } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockFetch: vi.fn(),
  mockGetSession: vi.fn(),
  mockForgetPassword: vi.fn(),
  mockResetPassword: vi.fn(),
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
    getSession: mockGetSession,
    forgetPassword: mockForgetPassword,
    resetPassword: mockResetPassword,
  },
}));

function renderPage(config: TenantConfig = DEFAULT_CONFIG, initialPath = "/admin/login") {
  return render(
    <BrandingContext.Provider value={{ config, isLoading: false }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AdminLoginPage />
      </MemoryRouter>
    </BrandingContext.Provider>
  );
}

/** Build a minimal Response-like object for fetch mocking. */
function makeFetchResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("AdminLoginPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockNavigate.mockClear();
    mockFetch.mockClear();
    mockGetSession.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    mockForgetPassword.mockClear();
    mockResetPassword.mockClear();
    // Replace global fetch with our mock
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
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
    mockFetch.mockResolvedValueOnce(makeFetchResponse(200, {}));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  it("calls getSession before navigating to ensure session is populated", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse(200, {}));
    const callOrder: string[] = [];
    mockGetSession.mockImplementationOnce(async () => {
      callOrder.push("getSession");
      return { data: { session: {}, user: {} }, error: null };
    });
    mockNavigate.mockImplementationOnce(() => { callOrder.push("navigate"); });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(callOrder).toEqual(["getSession", "navigate"]);
  });

  it("POSTs to /api/auth/sign-in/email with the entered email and password", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse(200, {}));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "secret123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/auth/sign-in/email",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "admin@example.com", password: "secret123" }),
        })
      );
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

  it("shows error message when fetch returns a non-ok non-429 status", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse(401, { detail: "Bad credentials" }));
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

  it("shows error message when fetch throws a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
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
    let resolve!: (value: Response) => void;
    mockFetch.mockImplementationOnce(
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
    resolve(makeFetchResponse(200, {}));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  it("disables submit button while loading", async () => {
    let resolve!: (value: Response) => void;
    mockFetch.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    resolve(makeFetchResponse(200, {}));
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

  // --- Forgot password ---

  it("renders the Forgot password? button on the login view", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();
  });

  it("clicking Forgot password? shows the reset view and hides the login form fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    // Reset view is visible
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← Back to login" })).toBeInTheDocument();
    // Login-specific elements are gone
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
  });

  it("clicking Back to login from the reset view returns to the login form", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.click(screen.getByRole("button", { name: "← Back to login" }));
    // Login fields are back
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("pre-fills the reset email field with the email typed on the login form", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "someone@example.com");
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const resetEmailInput = screen.getByLabelText("Email") as HTMLInputElement;
    expect(resetEmailInput.value).toBe("someone@example.com");
  });

  it("submitting the reset form calls authClient.forgetPassword with correct args", async () => {
    mockForgetPassword.mockResolvedValueOnce({ data: {}, error: null });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => {
      expect(mockForgetPassword).toHaveBeenCalledWith({
        email: "admin@example.com",
      });
    });
  });

  it("shows confirmation message on successful reset request", async () => {
    mockForgetPassword.mockResolvedValueOnce({ data: {}, error: null });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(screen.getByText("If that email is registered, a reset link has been sent.")).toBeInTheDocument();
    // Send reset link form is no longer visible
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument();
  });

  it("shows error message when forgetPassword returns an error", async () => {
    mockForgetPassword.mockResolvedValueOnce({
      data: null,
      error: { message: "Too many requests." },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Too many requests.")).toBeInTheDocument();
  });

  it("shows fallback error message when forgetPassword returns an error without message", async () => {
    mockForgetPassword.mockResolvedValueOnce({
      data: null,
      error: {},
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to send reset link.")).toBeInTheDocument();
  });

  it("shows error message when forgetPassword throws", async () => {
    mockForgetPassword.mockRejectedValueOnce(new Error("Network error"));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to send reset link. Please try again.")).toBeInTheDocument();
  });

  it("shows Sending… while the reset call is pending and hides it after", async () => {
    let resolve!: (value: { data: unknown; error: null }) => void;
    mockForgetPassword.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    // While pending: button shows Sending… and success has NOT appeared
    expect(screen.getByRole("button", { name: "Sending…" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Complete the call
    resolve({ data: {}, error: null });
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("disables Send reset link button while loading", async () => {
    let resolve!: (value: { data: unknown; error: null }) => void;
    mockForgetPassword.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    const emailInput = screen.getByLabelText("Email");
    await user.clear(emailInput);
    await user.type(emailInput, "admin@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    resolve({ data: {}, error: null });
  });

  it("Back to login clears any previous login error when returning", async () => {
    // Show a login error first
    mockFetch.mockResolvedValueOnce(makeFetchResponse(401, {}));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // Navigate to reset view and back
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.click(screen.getByRole("button", { name: "← Back to login" }));
    // Login error is cleared
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // --- 429 rate-limit countdown ---

  it("shows countdown message with role=status when 429 is returned", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(429, { detail: "Too many failed login attempts.", retry_after_seconds: 600 })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(screen.getByRole("status").textContent).toMatch(/Too many failed attempts/);
    expect(screen.getByRole("status").textContent).toMatch(/\d{2}:\d{2}/);
  });

  it("disables Sign in button while rate-limited", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(429, { detail: "Too many failed login attempts.", retry_after_seconds: 600 })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("does not navigate when 429 is returned", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(429, { detail: "Too many failed login attempts.", retry_after_seconds: 60 })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("uses 900s default when retry_after_seconds is absent from 429 body", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(429, { detail: "Too many failed login attempts." })
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    // 900 seconds = 15:00
    expect(screen.getByRole("status").textContent).toContain("15:00");
  });

  it("countdown re-enables button and removes status when it reaches zero", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(429, { detail: "Too many failed login attempts.", retry_after_seconds: 2 })
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    // Advance clock past the lockout
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Sign in" })).not.toBeDisabled();
  });

  it("sign-in button is NOT disabled before rate-limit is hit", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Sign in" })).not.toBeDisabled();
  });

  // --- Set new password view (arrives via reset email link with ?token=) ---

  it("shows the set-password view when URL contains a token query param", () => {
    renderPage(DEFAULT_CONFIG, "/admin/login?token=abc123");
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set new password" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("does not show set-password view when URL has no token", () => {
    renderPage(DEFAULT_CONFIG, "/admin/login");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("calls authClient.resetPassword with the new password and token from URL", async () => {
    mockResetPassword.mockResolvedValueOnce({ data: { status: true }, error: null });
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith({
        newPassword: "MyNewPass1!",
        token: "tok-xyz",
      });
    });
  });

  it("shows success message after password is set", async () => {
    mockResetPassword.mockResolvedValueOnce({ data: { status: true }, error: null });
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(screen.getByText("Password updated. You can now sign in with your new password.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set new password" })).not.toBeInTheDocument();
  });

  it("shows error message when resetPassword returns an error", async () => {
    mockResetPassword.mockResolvedValueOnce({
      data: null,
      error: { message: "Token expired." },
    });
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Token expired.")).toBeInTheDocument();
  });

  it("shows fallback error when resetPassword returns error without message", async () => {
    mockResetPassword.mockResolvedValueOnce({ data: null, error: {} });
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to set new password.")).toBeInTheDocument();
  });

  it("shows fallback error when resetPassword throws", async () => {
    mockResetPassword.mockRejectedValueOnce(new Error("Network error"));
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to set new password. Please try again.")).toBeInTheDocument();
  });

  it("shows Setting password… while the call is pending and disables the button", async () => {
    let resolve!: (value: { data: unknown; error: null }) => void;
    mockResetPassword.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(screen.getByRole("button", { name: "Setting password…" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    resolve({ data: { status: true }, error: null });
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("Back to login from set-password view returns to login form", async () => {
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← Back to login" }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  // --- Password requirements checklist (set-password view) ---

  it("shows password requirements checklist on set-password view", () => {
    renderPage(DEFAULT_CONFIG, "/admin/login?token=abc123");
    expect(screen.getByRole("list", { name: "Password requirements" })).toBeInTheDocument();
    expect(screen.getByText("At least 8 characters")).toBeInTheDocument();
    expect(screen.getByText("At least one uppercase letter (A–Z)")).toBeInTheDocument();
    expect(screen.getByText("At least one lowercase letter (a–z)")).toBeInTheDocument();
    expect(screen.getByText("At least one number (0–9)")).toBeInTheDocument();
  });

  it("Set new password button is disabled when password is empty", () => {
    renderPage(DEFAULT_CONFIG, "/admin/login?token=abc123");
    expect(screen.getByRole("button", { name: "Set new password" })).toBeDisabled();
  });

  it("Set new password button is disabled when password meets some but not all requirements", async () => {
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=abc123");
    // Only lowercase and digit — missing uppercase and length
    await user.type(screen.getByLabelText("New password"), "abc1");
    expect(screen.getByRole("button", { name: "Set new password" })).toBeDisabled();
  });

  it("Set new password button is enabled when all requirements are met", async () => {
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=abc123");
    await user.type(screen.getByLabelText("New password"), "MyPass1!");
    expect(screen.getByRole("button", { name: "Set new password" })).not.toBeDisabled();
  });

  it("requirements update in real time as the user types", async () => {
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=abc123");
    const input = screen.getByLabelText("New password");
    // Initially all unmet — all ✗
    const icons = () => document.querySelectorAll(".password-requirements__icon");
    expect(Array.from(icons()).every((el) => el.textContent === "✗")).toBe(true);
    // Type a password meeting all requirements
    await user.type(input, "MyPass12");
    // All requirements met — all ✓
    expect(Array.from(icons()).every((el) => el.textContent === "✓")).toBe(true);
  });

  it("Set new password button is disabled with loading regardless of valid password", async () => {
    let resolve!: (value: { data: unknown; error: null }) => void;
    mockResetPassword.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );
    const user = userEvent.setup();
    renderPage(DEFAULT_CONFIG, "/admin/login?token=tok-xyz");
    await user.type(screen.getByLabelText("New password"), "MyNewPass1!");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    // While pending: shows loading text and button is disabled
    expect(screen.getByRole("button", { name: "Setting password…" })).toBeDisabled();
    resolve({ data: { status: true }, error: null });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
  });
});
