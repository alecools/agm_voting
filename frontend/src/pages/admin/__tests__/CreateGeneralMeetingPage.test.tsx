import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CreateGeneralMeetingPage from "../CreateGeneralMeetingPage";

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
        <CreateGeneralMeetingPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CreateGeneralMeetingPage", () => {
  it("renders the page heading", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Create General Meeting" })).toBeInTheDocument();
  });

  it("renders the create form", () => {
    renderPage();
    expect(screen.getByLabelText("Title", { selector: "#agm-title" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create General Meeting" })).toBeInTheDocument();
  });

  it("renders back button", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "← Back" })).toBeInTheDocument();
  });

  it("clicking back navigates to /admin/general-meetings", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/general-meetings");
  });
});
