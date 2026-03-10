import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
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
        <AdminRoutes />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AdminRoutes", () => {
  it("renders admin layout with nav", () => {
    renderRoutes("/buildings");
    expect(screen.getByText("Admin Portal")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buildings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AGMs" })).toBeInTheDocument();
  });

  it("renders buildings page on /buildings", async () => {
    renderRoutes("/buildings");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    });
  });

  it("renders AGM list page on /agms", async () => {
    renderRoutes("/agms");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "AGMs" })).toBeInTheDocument();
    });
  });

  it("renders create AGM page on /agms/new", async () => {
    renderRoutes("/agms/new");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create AGM" })).toBeInTheDocument();
    });
  });

  it("redirects / to buildings", async () => {
    renderRoutes("/");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Buildings" })).toBeInTheDocument();
    });
  });
});
