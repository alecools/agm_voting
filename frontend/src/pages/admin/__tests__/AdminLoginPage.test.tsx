import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import AdminLoginPage from "../AdminLoginPage";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AdminLoginPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AdminLoginPage", () => {
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

  it("shows error message on invalid credentials", async () => {
    server.use(
      http.post("http://localhost:8000/api/admin/auth/login", () => {
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

  it("shows Signing in… while loading", async () => {
    let resolve!: (value: Response) => void;
    server.use(
      http.post("http://localhost:8000/api/admin/auth/login", () => {
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
      http.post("http://localhost:8000/api/admin/auth/login", () => {
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
});
