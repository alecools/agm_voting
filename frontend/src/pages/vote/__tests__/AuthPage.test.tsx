import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { AuthPage } from "../AuthPage";
import { AGM_ID } from "../../../../tests/msw/handlers";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";

const BASE = "http://localhost:8000";

// Navigation spy placeholder
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage(meetingId = AGM_ID, supportEmail = "") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <BrandingContext.Provider value={{ config: { ...DEFAULT_CONFIG, support_email: supportEmail }, isLoading: false }}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/vote/${meetingId}/auth`]}>
          <Routes>
            <Route path="/vote/:meetingId/auth" element={<AuthPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </BrandingContext.Provider>
  );
}

/**
 * Complete the full two-step auth flow:
 * 1. Fill email + click "Send Verification Code"
 * 2. Wait for step 2 to appear
 * 3. Fill code + click "Verify"
 */
async function fillAndSubmit(email: string, code = "TESTCODE") {
  const user = userEvent.setup();
  await waitFor(() => screen.getByLabelText("Email address"));
  await user.type(screen.getByLabelText("Email address"), email);
  await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
  // Wait for step 2
  await waitFor(() => screen.getByLabelText("Verification code"));
  await user.type(screen.getByLabelText("Verification code"), code);
  await user.click(screen.getByRole("button", { name: "Verify" }));
}

/**
 * Only complete step 1 (request OTP).
 */
async function fillStep1(email: string) {
  const user = userEvent.setup();
  await waitFor(() => screen.getByLabelText("Email address"));
  await user.type(screen.getByLabelText("Email address"), email);
  await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
}

describe("AuthPage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // --- Happy path ---
  it("renders 'Verify your identity' heading immediately", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Verify your identity" })).toBeInTheDocument();
  });

  it("'Send Verification Code' button is enabled immediately on render", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Send Verification Code" })).toBeEnabled();
  });

  it("navigates to voting page on success (not already submitted)", async () => {
    mockNavigate.mockClear();
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
    });
  });

  it("stores building_name and meeting_title in sessionStorage on success", async () => {
    mockNavigate.mockClear();
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(sessionStorage.getItem(`meeting_building_name_${AGM_ID}`)).toBe("Sunset Towers");
      expect(sessionStorage.getItem(`meeting_title_${AGM_ID}`)).toBe("2024 AGM");
    });
  });

  it("navigates to confirmation when all lots already_submitted=true and unvoted_visible_count=0", async () => {
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "42", financial_position: "normal", already_submitted: true, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "open",
          building_name: "Sunset Towers",
          meeting_title: "2024 AGM",
          unvoted_visible_count: 0,
        })
      )
    );
    mockNavigate.mockClear();
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("navigates to voting when hasRemainingLots is true even if unvoted_visible_count=0", async () => {
    // Simulates multi-lot voter where one lot already submitted all votes (so backend returns
    // unvoted_visible_count=0 for the submitted lot's motions), but another lot is still pending.
    // The frontend hasRemainingLots guard must catch this and route to voting.
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        HttpResponse.json({
          lots: [
            { lot_owner_id: "lo1", lot_number: "A", financial_position: "normal", already_submitted: true, is_proxy: false },
            { lot_owner_id: "lo2", lot_number: "B", financial_position: "normal", already_submitted: false, is_proxy: false },
          ],
          voter_email: "owner@example.com",
          agm_status: "open",
          building_name: "Sunset Towers",
          meeting_title: "2024 AGM",
          unvoted_visible_count: 0,
        })
      )
    );
    mockNavigate.mockClear();
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
    });
  });

  it("navigates to confirmation when agm_status=closed (submission view)", async () => {
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "42", financial_position: "normal", already_submitted: false, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "closed",
          building_name: "Sunset Towers",
          meeting_title: "2024 AGM",
        })
      )
    );
    mockNavigate.mockClear();
    renderPage(AGM_ID);
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("navigates to / with pendingMessage state when agm_status=pending", async () => {
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "42", financial_position: "normal", already_submitted: false, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "pending",
          building_name: "Sunset Towers",
          meeting_title: "2024 AGM",
        })
      )
    );
    mockNavigate.mockClear();
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", {
        state: { pendingMessage: "This meeting has not started yet. Please check back later." },
      });
    });
  });

  // --- Error handling ---
  it("shows 401 error message (invalid/expired code)", async () => {
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        HttpResponse.json({ detail: "Invalid or expired verification code" }, { status: 401 })
      )
    );
    renderPage();
    await fillAndSubmit("wrong@example.com");
    await waitFor(() => {
      expect(
        screen.getByText("Invalid or expired code. Please try again.")
      ).toBeInTheDocument();
    });
  });

  it("shows generic error for unexpected verify failure", async () => {
    server.use(
      http.post(`${BASE}/api/auth/verify`, () => HttpResponse.error())
    );
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(screen.getByText("An error occurred. Please try again.")).toBeInTheDocument();
    });
  });

  it("shows error when request-otp fails", async () => {
    server.use(
      http.post(`${BASE}/api/auth/request-otp`, () => HttpResponse.error())
    );
    renderPage();
    await fillStep1("owner@example.com");
    await waitFor(() => {
      expect(screen.getByText("Failed to send code. Please try again.")).toBeInTheDocument();
    });
  });

  // --- Loading states ---
  it("shows loading state on 'Sending...' while request-otp is in flight", async () => {
    let resolve!: () => void;
    server.use(
      http.post(`${BASE}/api/auth/request-otp`, () =>
        new Promise<Response>((res) => {
          resolve = () => res(HttpResponse.json({ sent: true }) as Response);
        })
      )
    );
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => screen.getByLabelText("Email address"));
    await user.type(screen.getByLabelText("Email address"), "a@b.com");
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
    });
    resolve();
  });

  it("shows loading state 'Verifying...' while verify is in flight", async () => {
    let resolve!: () => void;
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        new Promise<Response>((res) => {
          resolve = () =>
            res(HttpResponse.json({
              lots: [{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false }],
              voter_email: "x@y.com", agm_status: "open", building_name: "B", meeting_title: "T",
            }) as Response);
        })
      )
    );
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => screen.getByLabelText("Email address"));
    await user.type(screen.getByLabelText("Email address"), "a@b.com");
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    await waitFor(() => screen.getByLabelText("Verification code"));
    await user.type(screen.getByLabelText("Verification code"), "ABCD1234");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Verifying..." })).toBeDisabled();
    });
    resolve();
  });

  // --- Input validation ---
  it("shows empty email validation error when email is blank", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Email address"));
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    expect(screen.getByText("Email address is required")).toBeInTheDocument();
  });

  // --- UI structure ---
  it("renders back button", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
  });

  it("back button navigates to home", async () => {
    const user = userEvent.setup();
    mockNavigate.mockClear();
    renderPage();
    await waitFor(() => screen.getByLabelText("Email address"));
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  // --- Two-step flow ---
  it("shows step 2 code input after successful OTP request", async () => {
    renderPage();
    await fillStep1("owner@example.com");
    await waitFor(() => {
      expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
    });
  });

  it("clears authError on new requestOtp call", async () => {
    server.use(
      http.post(`${BASE}/api/auth/request-otp`, () => HttpResponse.error())
    );
    renderPage();
    await fillStep1("owner@example.com");
    await waitFor(() => {
      expect(screen.getByText("Failed to send code. Please try again.")).toBeInTheDocument();
    });
    // Now fix the handler so next call succeeds
    server.use(
      http.post(`${BASE}/api/auth/request-otp`, () => HttpResponse.json({ sent: true }))
    );
    // Resend is not visible since step 2 never loaded — click "Send Verification Code" again
    // by clicking the now-visible button (error state keeps us on step 1)
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
    await waitFor(() => {
      expect(screen.queryByText("Failed to send code. Please try again.")).not.toBeInTheDocument();
    });
  });

  // --- Session persistence (localStorage) ---

  it("stores session_token in localStorage after successful OTP verify", async () => {
    mockNavigate.mockClear();
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(localStorage.getItem(`agm_session_${AGM_ID}`)).toBe("test-session-token-abc123");
    });
  });

  it("does not store token in localStorage when session_token is empty", async () => {
    server.use(
      http.post(`${BASE}/api/auth/verify`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "open",
          building_name: "B",
          meeting_title: "T",
          unvoted_visible_count: 1,
          session_token: "",
        })
      )
    );
    renderPage();
    await fillAndSubmit("owner@example.com");
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
    });
    expect(localStorage.getItem(`agm_session_${AGM_ID}`)).toBeNull();
  });

  // --- Session restore on mount ---

  it("shows loading indicator when restoring session from localStorage", async () => {
    // Delay the session restore response to observe the loading state
    let resolveRestore!: () => void;
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        new Promise<Response>((res) => {
          resolveRestore = () =>
            res(HttpResponse.json({
              lots: [{ lot_owner_id: "lo-e2e", lot_number: "E2E-1", financial_position: "normal", already_submitted: false, is_proxy: false }],
              voter_email: "owner@example.com",
              agm_status: "open",
              building_name: "Sunset Towers",
              meeting_title: "2024 AGM",
              unvoted_visible_count: 1,
              session_token: "new-token",
            }) as Response);
        })
      )
    );
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to simulate a return visit with an existing session token
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Resuming your session…")).toBeInTheDocument();
    });
    resolveRestore();
  });

  it("skips OTP form and navigates to voting when valid token in localStorage", async () => {
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to simulate a return visit with an existing session token
    mockNavigate.mockClear();
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/voting`);
    });
    // OTP form should never have been shown
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("navigates to confirmation on restore when all lots already_submitted", async () => {
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: true, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "open",
          building_name: "B",
          meeting_title: "T",
          unvoted_visible_count: 0,
          session_token: "new-token",
        })
      )
    );
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to simulate a return visit with an existing session token
    mockNavigate.mockClear();
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("navigates to home with pending message on restore when agm_status=pending", async () => {
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "pending",
          building_name: "B",
          meeting_title: "T",
          unvoted_visible_count: 0,
          session_token: "new-token",
        })
      )
    );
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to simulate a return visit with an existing session token
    mockNavigate.mockClear();
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", {
        state: { pendingMessage: "This meeting has not started yet. Please check back later." },
      });
    });
  });

  it("navigates to confirmation on restore when agm_status=closed", async () => {
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({
          lots: [{ lot_owner_id: "lo1", lot_number: "1", financial_position: "normal", already_submitted: false, is_proxy: false }],
          voter_email: "owner@example.com",
          agm_status: "closed",
          building_name: "B",
          meeting_title: "T",
          unvoted_visible_count: 0,
          session_token: "new-token",
        })
      )
    );
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to simulate a return visit with an existing session token
    mockNavigate.mockClear();
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/confirmation`);
    });
  });

  it("updates localStorage with new token returned from session restore", async () => {
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to simulate a return visit with an existing session token
    renderPage();
    await waitFor(() => {
      expect(localStorage.getItem(`agm_session_${AGM_ID}`)).toBe("new-session-token-xyz789");
    });
  });

  it("clears stale token and shows OTP form when restore returns 401", async () => {
    server.use(
      http.post(`${BASE}/api/auth/session`, () =>
        HttpResponse.json({ detail: "Session expired or invalid" }, { status: 401 })
      )
    );
    localStorage.setItem(`agm_session_${AGM_ID}`, "invalid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage with a stale token to verify cleanup on 401 response
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    });
    expect(localStorage.getItem(`agm_session_${AGM_ID}`)).toBeNull();
  });

  it("clears stale token and shows OTP form on network error during restore", async () => {
    server.use(
      http.post(`${BASE}/api/auth/session`, () => HttpResponse.error())
    );
    localStorage.setItem(`agm_session_${AGM_ID}`, "valid-token"); // nosemgrep: no-localstorage-session-token -- test setup: seeding localStorage to verify cleanup on network error during restore
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    });
    expect(localStorage.getItem(`agm_session_${AGM_ID}`)).toBeNull();
  });

  it("shows OTP form immediately when no token in localStorage (no restore attempt)", async () => {
    // No token set in localStorage — restore should not run
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    });
  });

  // --- Support email (branding) ---

  it("shows support email link when support_email is set in branding config", () => {
    renderPage(AGM_ID, "help@example.com");
    expect(screen.getByRole("link", { name: "help@example.com" })).toBeInTheDocument();
    expect(screen.getByText(/Need help/)).toBeInTheDocument();
  });

  it("does not show support email block when support_email is empty", () => {
    renderPage(AGM_ID, "");
    expect(screen.queryByRole("link", { name: /mailto/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Need help/)).not.toBeInTheDocument();
  });
});
