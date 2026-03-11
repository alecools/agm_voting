import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CreateAGMPage from "../CreateAGMPage";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateAGMPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CreateAGMPage", () => {
  it("renders the page heading", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Create AGM" })).toBeInTheDocument();
  });

  it("renders the create AGM form", () => {
    renderPage();
    expect(screen.getByLabelText("Title", { selector: "#agm-title" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create AGM" })).toBeInTheDocument();
  });
});
