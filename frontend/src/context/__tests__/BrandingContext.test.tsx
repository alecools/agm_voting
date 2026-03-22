import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
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

function renderProvider() {
  return render(
    <BrandingProvider>
      <TestConsumer />
    </BrandingProvider>
  );
}

describe("BrandingContext", () => {
  beforeEach(() => {
    resetConfigFixture();
    // Reset any CSS properties set on document root
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
    // Config stays at defaults
    expect(screen.getByTestId("app-name").textContent).toBe(DEFAULT_CONFIG.app_name);
    expect(screen.getByTestId("primary-colour").textContent).toBe(DEFAULT_CONFIG.primary_colour);
  });

  it("does not update state after unmount (cancelled effect)", async () => {
    // Render and immediately unmount — should not throw "can't perform state update on unmounted component"
    const { unmount } = renderProvider();
    act(() => {
      unmount();
    });
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
