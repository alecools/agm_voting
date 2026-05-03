import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import ControlRoomPage from "../ControlRoomPage";
import { resetSubscriptionFixture } from "../../../../tests/msw/handlers";
import * as subscriptionApi from "../../../api/subscription";

const BASE = "http://localhost";

// Use vi.hoisted() so mock functions are available inside the hoisted vi.mock() factories.
const { mockNavigate, mockUseSession } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseSession: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    useSession: mockUseSession,
  },
}));

function makeSession(isOperator: boolean) {
  return { data: { user: { id: "u1", email: "op@example.com", role: isOperator ? "admin" : "user" } }, isPending: false };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ControlRoomPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ControlRoomPage", () => {
  beforeEach(() => {
    resetSubscriptionFixture();
    mockNavigate.mockClear();
    // Default: session pending
    mockUseSession.mockReturnValue({ data: null, isPending: true });
  });

  // --- Session loading ---

  it("shows loading state while session is pending", () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true });
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("does not show page content while session is pending", () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true });
    renderPage();
    expect(screen.queryByRole("heading", { name: "Control Room" })).not.toBeInTheDocument();
  });

  // --- Non-operator redirect ---

  it("redirects to /admin when user is not a server admin", async () => {
    mockUseSession.mockReturnValue({ data: { user: { id: "u1", role: "user" } }, isPending: false });
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  it("returns null (renders nothing) when user is not a server admin after session resolves", () => {
    mockUseSession.mockReturnValue({ data: { user: { id: "u1", role: "user" } }, isPending: false });
    renderPage();
    expect(screen.queryByRole("heading", { name: "Control Room" })).not.toBeInTheDocument();
  });

  it("redirects to /admin when session has no user", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false });
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/admin", { replace: true });
    });
  });

  // --- Operator happy path ---

  it("renders Control Room heading for server admin", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Room" })).toBeInTheDocument());
  });

  // --- Subscription section ---

  it("shows loading state while subscription is loading", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Room" })).toBeInTheDocument());
    // "Loading…" appears for both subscription and archived buildings sections initially
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("populates tier name and building limit fields from loaded subscription", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Growth", building_limit: 25, active_building_count: 7 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue("Growth"));
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(25);
  });

  it("leaves building limit field empty when building_limit is null (unlimited)", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Enterprise", building_limit: null, active_building_count: 5 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue("Enterprise"));
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(null);
  });

  it("sets tier name field to empty string when tier_name is null (covers line 40 null branch)", async () => {
    // Exercises data.tier_name ?? "" — null branch sets tierName to "".
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: 5, active_building_count: 2 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue(""));
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(5);
  });

  it("shows error when subscription fetch fails", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "Forbidden" }, { status: 403 })
      )
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Failed to load subscription settings.")).toBeInTheDocument()
    );
  });

  it("saves subscription settings and shows success message", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      ),
      http.post(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Growth", building_limit: 20, active_building_count: 3 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue("Starter"));

    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Growth" } });
    await user.clear(screen.getByLabelText("Building limit (leave blank for unlimited)"));
    await user.type(screen.getByLabelText("Building limit (leave blank for unlimited)"), "20");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Subscription settings saved.")).toBeInTheDocument()
    );
  });

  it("shows Saving… while subscription save is in flight", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      ),
      http.post(`${BASE}/api/admin/subscription`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
  });

  it("shows error when subscription save fails", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      ),
      http.post(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "Validation error" }, { status: 422 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/HTTP 422/)).toBeInTheDocument());
  });

  it("shows fallback error when subscription save throws non-Error value", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      )
    );
    vi.spyOn(subscriptionApi, "updateSubscription").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/Failed to save subscription/)).toBeInTheDocument());
  });

  it("save with blank tier name sends null (covers line 59 empty-string branch)", async () => {
    // Exercises tierName.trim() || null — empty string evaluates to null in the payload.
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    let capturedBody: unknown = null;
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      ),
      http.post(`${BASE}/api/admin/subscription`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ tier_name: null, building_limit: 10, active_building_count: 3 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue("Starter"));
    // Select the blank option so tier name becomes empty string
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Subscription settings saved.")).toBeInTheDocument());
    expect((capturedBody as { tier_name: unknown }).tier_name).toBeNull();
  });

  it("save with blank limit sends null (unlimited)", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    let capturedBody: unknown = null;
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Enterprise", building_limit: null, active_building_count: 2 })
      ),
      http.post(`${BASE}/api/admin/subscription`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ tier_name: "Enterprise", building_limit: null, active_building_count: 2 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue("Enterprise"));
    // building_limit field is empty (null) — leave it blank and save
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Subscription settings saved.")).toBeInTheDocument());
    expect((capturedBody as { building_limit: unknown }).building_limit).toBeNull();
  });

  // --- Archived buildings section ---

  it("shows empty state when no archived buildings exist", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([])
      )
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No archived buildings.")).toBeInTheDocument()
    );
  });

  it("shows archived buildings in a table", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 2, created_at: "2022-01-01T00:00:00Z" },
        ])
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Gamma House")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
  });

  it("shows error when archived buildings fetch fails", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json({ detail: "Error" }, { status: 500 })
      )
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Failed to load archived buildings.")).toBeInTheDocument()
    );
  });

  it("unarchiving a building removes it from the list", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 0, created_at: "2022-01-01T00:00:00Z" },
          { id: "b4", name: "Delta Court", manager_email: "delta@example.com", is_archived: true, unarchive_count: 0, created_at: "2021-01-01T00:00:00Z" },
        ])
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Gamma House")).toBeInTheDocument());
    expect(screen.getByText("Delta Court")).toBeInTheDocument();

    // Unarchive Gamma House (first button)
    const unarchiveBtns = screen.getAllByRole("button", { name: "Unarchive" });
    await user.click(unarchiveBtns[0]);

    await waitFor(() => expect(screen.queryByText("Gamma House")).not.toBeInTheDocument());
    // Delta Court remains
    expect(screen.getByText("Delta Court")).toBeInTheDocument();
  });

  it("shows Unarchiving… while in flight and disables the button", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 0, created_at: "2022-01-01T00:00:00Z" },
        ])
      ),
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ id: "b3", name: "Gamma House", is_archived: false });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Unarchive" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    expect(screen.getByRole("button", { name: "Unarchiving…" })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText("Gamma House")).not.toBeInTheDocument());
  });

  it("shows error when unarchive fails", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 0, created_at: "2022-01-01T00:00:00Z" },
        ])
      ),
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Unarchive" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(screen.getByText(/HTTP 404/)).toBeInTheDocument());
  });

  it("shows fallback error when unarchive throws non-Error value", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 0, created_at: "2022-01-01T00:00:00Z" },
        ])
      )
    );
    vi.spyOn(subscriptionApi, "unarchiveBuilding").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Unarchive" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(screen.getByText(/Failed to unarchive building/)).toBeInTheDocument());
  });

  // --- UI has NOT transitioned while async work is pending ---

  it("unarchive: building row is still present while request is in flight, gone after it completes", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 0, created_at: "2022-01-01T00:00:00Z" },
        ])
      ),
      http.post(`${BASE}/api/admin/buildings/:buildingId/unarchive`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ id: "b3", name: "Gamma House", is_archived: false });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Unarchive" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    // While in flight: row still present (button shows "Unarchiving…")
    expect(screen.getByText("Gamma House")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to unarchive/)).not.toBeInTheDocument();
    // After completion: row gone
    await waitFor(() => expect(screen.queryByText("Gamma House")).not.toBeInTheDocument());
  });

  // --- Subscription success message auto-dismissal ---

  it("save success message disappears after 3 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      ),
      http.post(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Subscription settings saved.")).toBeInTheDocument());
    vi.advanceTimersByTime(3100);
    await waitFor(() => expect(screen.queryByText("Subscription settings saved.")).not.toBeInTheDocument());
    vi.useRealTimers();
  });

  // --- Tier picker option labels ---

  it("tier select shows building limit labels in options", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toBeInTheDocument());
    const select = screen.getByLabelText("Tier name");
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.text);
    expect(options).toContain("Free (1 building)");
    expect(options).toContain("Starter (up to 10 buildings)");
    expect(options).toContain("Growth (up to 25 buildings)");
    expect(options).toContain("Expansion (up to 50 buildings)");
    expect(options).toContain("Enterprise (unlimited)");
  });

  // --- Auto-populate building limit from selected tier ---

  it("selecting Free tier auto-populates building limit to 1", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Free" } });
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(1);
  });

  it("selecting Starter tier auto-populates building limit to 10", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Starter" } });
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(10);
  });

  it("selecting Growth tier auto-populates building limit to 25", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Growth" } });
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(25);
  });

  it("selecting Expansion tier auto-populates building limit to 50", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Expansion" } });
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(50);
  });

  it("selecting Enterprise tier clears the building limit field (unlimited)", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toHaveValue("Starter"));
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Enterprise" } });
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(null);
  });

  it("building limit input remains editable after tier auto-populate", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 0 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Tier name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tier name"), { target: { value: "Starter" } });
    // Auto-populated to 10
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(10);
    // Override manually
    await user.clear(screen.getByLabelText("Building limit (leave blank for unlimited)"));
    await user.type(screen.getByLabelText("Building limit (leave blank for unlimited)"), "15");
    expect(screen.getByLabelText("Building limit (leave blank for unlimited)")).toHaveValue(15);
  });

  // --- Times unarchived column ---

  it("renders 'Times unarchived' column header in archived buildings table", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 0, created_at: "2022-01-01T00:00:00Z" },
        ])
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Gamma House")).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "Times unarchived" })).toBeInTheDocument();
  });

  it("displays unarchive_count value for each archived building", async () => {
    mockUseSession.mockReturnValue(makeSession(true));
    server.use(
      http.get(`${BASE}/api/admin/buildings`, () =>
        HttpResponse.json([
          { id: "b3", name: "Gamma House", manager_email: "gamma@example.com", is_archived: true, unarchive_count: 3, created_at: "2022-01-01T00:00:00Z" },
          { id: "b4", name: "Delta Court", manager_email: "delta@example.com", is_archived: true, unarchive_count: 0, created_at: "2021-01-01T00:00:00Z" },
        ])
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Gamma House")).toBeInTheDocument());
    expect(screen.getByText("Delta Court")).toBeInTheDocument();
    // unarchive_count values appear as cell text
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });
});
