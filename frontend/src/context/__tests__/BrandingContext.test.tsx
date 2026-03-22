import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server } from "../../../tests/msw/server";
import { BrandingProvider, useBranding, DEFAULT_CONFIG } from "../BrandingContext";
import { resetConfigFixture, configFixture } from "../../../tests/msw/handlers";

const BASE = "http://localhost:8000";

function TestConsumer() {
  const { config, isLoading } = useBranding();
  return (
    <div>
      <span data-testid="app-name">{config.app_name}</span>
      <span data-testid="logo-url">{config.logo_url}</span>
      <span data-testid="primary-colour">{config.primary_colour}</span>
      <span data-testid="support-email">{config.support_email}</span>
      <span data-testid="is-loading">{isLoading ? "loading" : "ready"}</span>
    </div>
  );
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderProvider(qc?: QueryClient) {
  const client = qc ?? makeQC();
  return render(
    <QueryClientProvider client={client}>
      <BrandingProvider>
        <TestConsumer />
      </BrandingProvider>
    </QueryClientProvider>
  );
}

describe("BrandingContext", () => {
  beforeEach(() => {
    resetConfigFixture();
    document.documentElement.style.removeProperty("--color-primary");
    document.title = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Happy path ---

  it("renders children while loading and then resolves", async () => {
    renderProvider();
    // Children render immediately (no suspense)
    expect(screen.getByTestId("app-name")).toBeInTheDocument();
    // Eventually transitions to ready
    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("ready")
    );
  });

  it("loads config from public endpoint and updates consumer", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("ready")
    );
    expect(screen.getByTestId("app-name").textContent).toBe("AGM Voting");
    expect(screen.getByTestId("primary-colour").textContent).toBe("#005f73");
  });

  it("applies custom app_name from API response", async () => {
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "Corp Vote", logo_url: "", primary_colour: "#ff0000", support_email: "" })
      )
    );
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("app-name").textContent).toBe("Corp Vote")
    );
  });

  it("sets --color-primary CSS variable on document root", async () => {
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "Test", logo_url: "", primary_colour: "#1a2b3c", support_email: "" })
      )
    );
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("ready")
    );
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("#1a2b3c");
  });

  it("sets document.title to app_name", async () => {
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "My AGM App", logo_url: "", primary_colour: "#000000", support_email: "" })
      )
    );
    renderProvider();
    await waitFor(() =>
      expect(document.title).toBe("My AGM App")
    );
  });

  it("exposes support_email from config", async () => {
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "Test", logo_url: "", primary_colour: "#000000", support_email: "help@test.com" })
      )
    );
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("support-email").textContent).toBe("help@test.com")
    );
  });

  it("exposes logo_url from config", async () => {
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "Test", logo_url: "https://example.com/logo.png", primary_colour: "#000", support_email: "" })
      )
    );
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("logo-url").textContent).toBe("https://example.com/logo.png")
    );
  });

  // --- Error / edge cases ---

  it("keeps defaults when API fetch fails", async () => {
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ detail: "Server error" }, { status: 500 })
      )
    );
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("ready")
    );
    // Config stays at defaults (placeholderData)
    expect(screen.getByTestId("app-name").textContent).toBe(DEFAULT_CONFIG.app_name);
    expect(screen.getByTestId("primary-colour").textContent).toBe(DEFAULT_CONFIG.primary_colour);
  });

  it("re-fetches config when query is invalidated", async () => {
    const qc = makeQC();
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "Initial", logo_url: "", primary_colour: "#111111", support_email: "" })
      )
    );
    renderProvider(qc);
    await waitFor(() =>
      expect(screen.getByTestId("app-name").textContent).toBe("Initial")
    );

    // Swap MSW handler to return updated config
    server.use(
      http.get(`${BASE}/api/config`, () =>
        HttpResponse.json({ app_name: "Updated", logo_url: "", primary_colour: "#222222", support_email: "" })
      )
    );

    // Invalidate — BrandingProvider should re-fetch
    await qc.invalidateQueries({ queryKey: ["public-config"] });

    await waitFor(() =>
      expect(screen.getByTestId("app-name").textContent).toBe("Updated")
    );
  });

  it("does not throw when unmounted before fetch resolves", async () => {
    // Delay the response so we can unmount before it resolves
    server.use(
      http.get(`${BASE}/api/config`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ app_name: "Late", logo_url: "", primary_colour: "#005f73", support_email: "" });
      })
    );
    const { unmount } = renderProvider();
    // Unmount before the response arrives — React Query handles cleanup
    unmount();
    // No assertion needed — test passes if no error is thrown
  });

  // --- DEFAULT_CONFIG export ---

  it("DEFAULT_CONFIG has expected shape", () => {
    expect(DEFAULT_CONFIG.app_name).toBe("AGM Voting");
    expect(DEFAULT_CONFIG.logo_url).toBe("");
    expect(DEFAULT_CONFIG.primary_colour).toBe("#005f73");
    expect(DEFAULT_CONFIG.support_email).toBe("");
  });

  // --- configFixture is mutated correctly by MSW handler ---

  it("configFixture reflects fixture value from handlers", () => {
    expect(configFixture.app_name).toBe("AGM Voting");
  });
});
