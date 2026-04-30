import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import RequireAdminAuth from "../RequireAdminAuth";

// vi.mock is hoisted to the top of the file by Vitest's transform.
// Use vi.hoisted() so the mock function variable is available in the factory.
const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
}));

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useSession: mockUseSession,
  },
}));

function renderWithSession(
  sessionData: { data: unknown; isPending: boolean }
) {
  mockUseSession.mockReturnValue(sessionData);

  return render(
    <MemoryRouter initialEntries={["/protected"]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireAdminAuth>
              <div>Protected Content</div>
            </RequireAdminAuth>
          }
        />
        <Route path="/admin/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("RequireAdminAuth", () => {
  // --- Loading state ---

  it("shows loading state when session is pending", () => {
    renderWithSession({ data: null, isPending: true });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("does not render children while loading", () => {
    renderWithSession({ data: null, isPending: true });
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
  });

  it("does not redirect while loading", () => {
    renderWithSession({ data: null, isPending: true });
    expect(screen.queryByText("Login Page")).not.toBeInTheDocument();
  });

  // --- Authenticated ---

  it("renders children when session data is present", async () => {
    renderWithSession({
      data: { user: { email: "admin@example.com" }, session: {} },
      isPending: false,
    });
    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeInTheDocument();
    });
  });

  it("does not redirect when authenticated", () => {
    renderWithSession({
      data: { user: { email: "admin@example.com" }, session: {} },
      isPending: false,
    });
    expect(screen.queryByText("Login Page")).not.toBeInTheDocument();
  });

  // --- Unauthenticated ---

  it("redirects to /admin/login when session data is null", async () => {
    renderWithSession({ data: null, isPending: false });
    await waitFor(() => {
      expect(screen.getByText("Login Page")).toBeInTheDocument();
    });
  });

  it("does not render children when unauthenticated", () => {
    renderWithSession({ data: null, isPending: false });
    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
  });
});
