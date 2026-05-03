import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { BuildingSelectPage } from "../BuildingSelectPage";
import { BUILDING_ID, AGM_ID } from "../../../../tests/msw/handlers";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const BASE = "http://localhost";

function renderPage(path = "/", locationState?: { pendingMessage?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[{ pathname: path, state: locationState }]}>
        <BuildingSelectPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("BuildingSelectPage", () => {
  it("shows loading state inside card while page hero remains visible", () => {
    renderPage();
    // Hero renders immediately
    expect(screen.getByText("Cast Your Vote")).toBeInTheDocument();
    // Loading message appears inside the card (not replacing the full page)
    expect(screen.getByText("Loading buildings...")).toBeInTheDocument();
  });

  it("shows pending message banner when navigated from auth with pendingMessage state", async () => {
    renderPage("/", { pendingMessage: "This meeting has not started yet. Please check back later." });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "This meeting has not started yet. Please check back later."
      );
    });
  });

  it("does not show pending message banner when no state provided", async () => {
    renderPage("/");
    // Wait for buildings to load so main content is rendered, then assert no status banner
    await waitFor(() => screen.getByLabelText("Select your building"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Helper: select a building by name via the combobox
  async function selectBuilding(user: ReturnType<typeof userEvent.setup>, buildingName: string) {
    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, buildingName);
    // Wait for the option to appear in the listbox and click it
    await waitFor(() => screen.getByRole("option", { name: buildingName }));
    await user.click(screen.getByRole("option", { name: buildingName }));
  }

  it("renders building combobox after load", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
      expect(screen.getByLabelText("Select your building")).toBeInTheDocument();
    });
  });

  it("typing in combobox shows matching options", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.type(input, "Sunset");
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Sunset Towers" })).toBeInTheDocument();
    });
  });

  it("shows error when buildings fail to load", async () => {
    server.use(
      http.get(`${BASE}/api/buildings`, () => HttpResponse.error())
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to load buildings");
    });
  });

  it("fetches and shows AGMs when building selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
  });

  it("shows Enter Voting button for open AGM", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enter Voting" })).toBeInTheDocument();
    });
  });

  it("shows View My Submission button for closed AGM", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View My Submission" })).toBeInTheDocument();
    });
  });

  it("shows General Meetings loading state briefly before General Meetings appear", async () => {
    let resolveAGMs!: (value: Response) => void;
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () =>
        new Promise<Response>((res) => {
          resolveAGMs = res;
        })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    // While AGMs are still loading (pending promise)
    await waitFor(() => {
      expect(screen.getByText("Loading General Meetings...")).toBeInTheDocument();
    });
    resolveAGMs(HttpResponse.json([]) as unknown as Response);
    await waitFor(() => {
      expect(screen.queryByText("Loading General Meetings...")).not.toBeInTheDocument();
    });
  });

  it("shows empty AGM list when no AGMs returned", async () => {
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/general-meetings`, () =>
        HttpResponse.json([])
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    await waitFor(() => {
      expect(screen.getByText("No General Meetings found for this building.")).toBeInTheDocument();
    });
  });

  it("navigates to auth when Enter Voting clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    await waitFor(() => screen.getByRole("button", { name: "Enter Voting" }));
    await user.click(screen.getByRole("button", { name: "Enter Voting" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/auth`);
  });

  it("navigates to auth with view=submission when View My Submission clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole("combobox"));
    await selectBuilding(user, "Sunset Towers");
    await waitFor(() => screen.getByRole("button", { name: "View My Submission" }));
    await user.click(screen.getByRole("button", { name: "View My Submission" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/agm-closed-999/auth?view=submission`);
  });
});
