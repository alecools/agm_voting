import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { VoterShell } from "../VoterShell";
import { BrandingContext, DEFAULT_CONFIG } from "../../../context/BrandingContext";
import type { TenantConfig } from "../../../api/config";

function renderShell(config: TenantConfig = DEFAULT_CONFIG, isLoading = false) {
  return render(
    <BrandingContext.Provider value={{ config, isLoading }}>
      <MemoryRouter>
        <VoterShell />
      </MemoryRouter>
    </BrandingContext.Provider>
  );
}

describe("VoterShell", () => {
  // --- Happy path ---

  it("renders the voter layout wrapper", () => {
    const { container } = renderShell();
    expect(container.querySelector(".voter-layout")).toBeInTheDocument();
  });

  it("renders the app-header", () => {
    const { container } = renderShell();
    expect(container.querySelector(".app-header")).toBeInTheDocument();
  });

  // --- Conditional logo/app-name rendering ---

  it("renders app-name text when logo_url is empty", () => {
    renderShell({ ...DEFAULT_CONFIG, logo_url: "" });
    expect(screen.getByText("AGM Voting")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders img element when logo_url is set", () => {
    renderShell({ ...DEFAULT_CONFIG, logo_url: "https://example.com/logo.png" });
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://example.com/logo.png");
    expect(img).toHaveAttribute("alt", "AGM Voting");
    expect(screen.queryByText("AGM Voting")).not.toBeInTheDocument();
  });

  it("uses config app_name as alt text for logo img", () => {
    renderShell({ ...DEFAULT_CONFIG, app_name: "Corp Vote", logo_url: "https://example.com/logo.png" });
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Corp Vote");
  });

  it("renders custom app_name as text when no logo", () => {
    renderShell({ ...DEFAULT_CONFIG, app_name: "My Organisation AGM", logo_url: "" });
    expect(screen.getByText("My Organisation AGM")).toBeInTheDocument();
  });

  // --- Loading state ---

  it("renders with default config during loading state", () => {
    renderShell(DEFAULT_CONFIG, true);
    expect(screen.getByText("AGM Voting")).toBeInTheDocument();
  });
});
