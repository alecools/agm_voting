import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import RequireAdminAuth from "../RequireAdminAuth";

function renderWithAuth(authenticated: boolean) {
  server.use(
    http.get("http://localhost:8000/api/admin/auth/me", () => {
      if (authenticated) {
        return HttpResponse.json({ authenticated: true });
      }
      return HttpResponse.json({ detail: "Not authenticated" }, { status: 401 });
    })
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
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
    </QueryClientProvider>
  );
}

describe("RequireAdminAuth", () => {
  it("shows loading state initially", () => {
    renderWithAuth(true);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders children when authenticated", async () => {
    renderWithAuth(true);
    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeInTheDocument();
    });
  });

  it("redirects to /admin/login when not authenticated", async () => {
    renderWithAuth(false);
    await waitFor(() => {
      expect(screen.getByText("Login Page")).toBeInTheDocument();
    });
  });
});
