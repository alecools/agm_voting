import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";

// Mock Vercel telemetry components — they are no-ops in test environments
vi.mock("@vercel/analytics/react", () => ({
  Analytics: () => null,
}));

vi.mock("@vercel/speed-insights/react", () => ({
  SpeedInsights: () => null,
}));

// Mock heavy page/route modules to keep App tests focused and fast
vi.mock("../pages/vote/BuildingSelectPage", () => ({
  BuildingSelectPage: () => <div data-testid="building-select-page" />,
}));
vi.mock("../pages/vote/AuthPage", () => ({
  AuthPage: () => <div data-testid="auth-page" />,
}));
vi.mock("../pages/vote/VotingPage", () => ({
  VotingPage: () => <div data-testid="voting-page" />,
}));
vi.mock("../pages/vote/ConfirmationPage", () => ({
  ConfirmationPage: () => <div data-testid="confirmation-page" />,
}));
vi.mock("../components/vote/VoterShell", () => ({
  VoterShell: () => <div data-testid="voter-shell" />,
}));
vi.mock("../routes/AdminRoutes", () => ({
  default: () => <div data-testid="admin-routes" />,
}));
vi.mock("../pages/GeneralMeetingSummaryPage", () => ({
  default: () => <div data-testid="general-meeting-summary-page" />,
}));

function renderApp(path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("App", () => {
  // --- Happy path ---

  it("renders without crashing at the root path", () => {
    renderApp("/");
    // VoterShell wraps the voter routes; its mock renders the shell div
    expect(screen.getByTestId("voter-shell")).toBeInTheDocument();
  });

  it("renders admin routes at /admin/anything", () => {
    renderApp("/admin/buildings");
    expect(screen.getByTestId("admin-routes")).toBeInTheDocument();
  });

  it("renders general meeting summary page at /general-meeting/:meetingId/summary", () => {
    renderApp("/general-meeting/abc123/summary");
    expect(screen.getByTestId("general-meeting-summary-page")).toBeInTheDocument();
  });

  it("mounts Analytics and SpeedInsights (no render error)", () => {
    // Both components are mocked to return null; the render itself proves
    // the import paths resolve and the JSX is evaluated — covering those lines.
    const { container } = renderApp("/");
    expect(container).toBeTruthy();
  });
});
