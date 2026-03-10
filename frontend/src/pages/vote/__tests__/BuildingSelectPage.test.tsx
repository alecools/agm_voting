import React from "react";
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

const BASE = "http://localhost:8000";

function renderPage(path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <BuildingSelectPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("BuildingSelectPage", () => {
  it("shows loading state initially", () => {
    renderPage();
    expect(screen.getByText("Loading buildings...")).toBeInTheDocument();
  });


  it("renders building dropdown after load", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Select your building")).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Sunset Towers" })).toBeInTheDocument();
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
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    await waitFor(() => {
      expect(screen.getByText("2024 AGM")).toBeInTheDocument();
    });
  });

  it("shows Enter Voting button for open AGM", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enter Voting" })).toBeInTheDocument();
    });
  });

  it("shows View My Submission button for closed AGM", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View My Submission" })).toBeInTheDocument();
    });
  });

  it("shows AGMs loading state briefly before AGMs appear", async () => {
    let resolveAGMs!: (value: Response) => void;
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () =>
        new Promise<Response>((res) => {
          resolveAGMs = res;
        })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    // While AGMs are still loading (pending promise)
    await waitFor(() => {
      expect(screen.getByText("Loading AGMs...")).toBeInTheDocument();
    });
    resolveAGMs(HttpResponse.json([]) as unknown as Response);
    await waitFor(() => {
      expect(screen.queryByText("Loading AGMs...")).not.toBeInTheDocument();
    });
  });

  it("shows empty AGM list when no AGMs returned", async () => {
    server.use(
      http.get(`${BASE}/api/buildings/${BUILDING_ID}/agms`, () =>
        HttpResponse.json([])
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    await waitFor(() => {
      expect(screen.getByText("No AGMs found for this building.")).toBeInTheDocument();
    });
  });

  it("navigates to auth when Enter Voting clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    await waitFor(() => screen.getByRole("button", { name: "Enter Voting" }));
    await user.click(screen.getByRole("button", { name: "Enter Voting" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/${AGM_ID}/auth`);
  });

  it("navigates to auth with view=submission when View My Submission clicked", async () => {
    mockNavigate.mockClear();
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByLabelText("Select your building"));
    await user.selectOptions(screen.getByRole("combobox"), BUILDING_ID);
    await waitFor(() => screen.getByRole("button", { name: "View My Submission" }));
    await user.click(screen.getByRole("button", { name: "View My Submission" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/vote/agm-closed-999/auth?view=submission`);
  });
});
