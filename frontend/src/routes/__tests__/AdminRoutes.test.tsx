import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import AdminRoutes from "../AdminRoutes";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

function renderRoutes(initialPath = "/admin") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/admin/*" element={<AdminRoutes />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AdminRoutes", () => {
  it("renders login page on /admin/login", () => {
    renderRoutes("/admin/login");
    expect(screen.getByRole("heading", { name: "Admin Portal" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("renders admin layout with nav when authenticated", async () => {
    renderRoutes("/admin/buildings");
    await waitFor(() => {
      expect(screen.getByText("Admin Portal")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Buildings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "General Meetings" })).toBeInTheDocument();
  });

  it("renders buildings page on /admin/buildings when authenticated", async () => {
    renderRoutes("/admin/buildings");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    });
  });

  it("renders General Meeting list page on /admin/general-meetings when authenticated", async () => {
    renderRoutes("/admin/general-meetings");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "General Meetings" })).toBeInTheDocument();
    });
  });

  it("renders create General Meeting page on /admin/general-meetings/new when authenticated", async () => {
    renderRoutes("/admin/general-meetings/new");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create General Meeting" })).toBeInTheDocument();
    });
  });

  it("redirects /admin to buildings when authenticated", async () => {
    renderRoutes("/admin");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    });
  });

  it("redirects to /admin/login when not authenticated", async () => {
    server.use(
      http.get("http://localhost:8000/api/admin/auth/me", () => {
        return HttpResponse.json({ detail: "Not authenticated" }, { status: 401 });
      })
    );
    renderRoutes("/admin/buildings");
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });
  });
});
