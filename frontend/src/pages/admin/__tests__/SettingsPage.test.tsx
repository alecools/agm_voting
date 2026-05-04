import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import SettingsPage from "../SettingsPage";
import { resetConfigFixture, resetAdminUsersFixture, resetSubscriptionFixture, CURRENT_USER_ID, ADMIN_USER_CURRENT, ADMIN_USER_OTHER } from "../../../../tests/msw/handlers";
import * as configApi from "../../../api/config";
import * as usersApi from "../../../api/users";
import * as subscriptionApi from "../../../api/subscription";
import { vi } from "vitest";
import { authClient, changePassword as changePasswordFn } from "../../../lib/auth-client";

const BASE = "http://localhost";

// Mock auth-client so getSession and changePassword return predictable values.
// NOTE: vi.mock is hoisted before imports, so we cannot use imported constants here.
// The literal "current-admin-id" must match CURRENT_USER_ID exported from handlers.ts.
vi.mock("../../../lib/auth-client", () => ({
  authClient: {
    getSession: vi.fn().mockResolvedValue({
      data: { user: { id: "current-admin-id" } },
    }),
  },
  changePassword: vi.fn().mockResolvedValue({ error: null }),
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    resetConfigFixture();
    resetAdminUsersFixture();
    resetSubscriptionFixture();
  });

  // --- Happy path ---

  it("shows loading state while fetching config", () => {
    renderPage();
    expect(screen.getByText("Loading settings…")).toBeInTheDocument();
  });

  it("renders tab navigation after config loads", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "UI & Theme" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument();
  });

  it("UI & Theme tab is active by default", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "UI & Theme" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "UI & Theme" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Email Server" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "User Management" })).toHaveAttribute("aria-selected", "false");
  });

  it("renders form fields after config loads on UI & Theme tab", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("App name")).toBeInTheDocument());
    expect(screen.getByLabelText("Logo URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Primary colour")).toBeInTheDocument();
    expect(screen.getByLabelText("Support email")).toBeInTheDocument();
  });

  it("populates form with loaded config values", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config`, () =>
        HttpResponse.json({ app_name: "Test Corp", logo_url: "https://example.com/logo.png", primary_colour: "#123456", support_email: "help@test.com" })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("App name")).toHaveValue("Test Corp"));
    expect(screen.getByLabelText("Logo URL")).toHaveValue("https://example.com/logo.png");
    expect(screen.getByLabelText("Support email")).toHaveValue("help@test.com");
  });

  it("shows page heading", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument());
  });

  it("shows Save button after loading on UI & Theme tab", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("branding-save-btn")).toBeInTheDocument());
  });

  it("saves settings and shows success message", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("App name")).toBeInTheDocument());

    await user.clear(screen.getByLabelText("App name"));
    await user.type(screen.getByLabelText("App name"), "New Corp AGM");
    await user.click(screen.getByTestId("branding-save-btn"));

    await waitFor(() => expect(screen.getByText("Settings saved.")).toBeInTheDocument());
  });

  it("updates public-config query cache immediately on save without waiting for refetch", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByLabelText("App name")).toBeInTheDocument());

    await user.clear(screen.getByLabelText("App name"));
    await user.type(screen.getByLabelText("App name"), "Instant Brand");
    await user.click(screen.getByTestId("branding-save-btn"));

    await waitFor(() => expect(screen.getByText("Settings saved.")).toBeInTheDocument());

    // The cache should be updated immediately with the saved values
    const cached = qc.getQueryData<{ app_name: string }>(["public-config"]);
    expect(cached?.app_name).toBe("Instant Brand");
  });

  it("disables Save button while saving", async () => {
    const user = userEvent.setup();
    // Slow the response so we can observe the disabled state
    server.use(
      http.put(`${BASE}/api/admin/config`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ app_name: "Test", logo_url: "", primary_colour: "#005f73", support_email: "" });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("branding-save-btn")).toBeInTheDocument());
    await user.click(screen.getByTestId("branding-save-btn"));
    expect(screen.getByTestId("branding-save-btn")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("branding-save-btn")).not.toBeDisabled());
  });

  it("success message disappears after 3 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("App name")).toBeInTheDocument());
    await user.click(screen.getByTestId("branding-save-btn"));
    await waitFor(() => expect(screen.getByText("Settings saved.")).toBeInTheDocument());
    act(() => vi.advanceTimersByTime(3100));
    await waitFor(() => expect(screen.queryByText("Settings saved.")).not.toBeInTheDocument());
    vi.useRealTimers();
  });

  // --- Error states ---

  it("shows error when config load fails", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config`, () =>
        HttpResponse.json({ detail: "Internal error" }, { status: 500 })
      )
    );
    renderPage();
    await waitFor(() =>
      expect(screen.queryByText("Loading settings…")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Failed to load settings.")).toBeInTheDocument();
  });

  it("shows error message when save fails with HTTP error", async () => {
    server.use(
      http.put(`${BASE}/api/admin/config`, () =>
        HttpResponse.json({ detail: "Validation error" }, { status: 422 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("branding-save-btn")).toBeInTheDocument());
    await userEvent.setup().click(screen.getByTestId("branding-save-btn"));
    await waitFor(() => expect(screen.getByText(/HTTP 422/)).toBeInTheDocument());
  });

  it("shows fallback error message when save throws non-Error value", async () => {
    // Cover the `false` branch of `err instanceof Error ? err.message : "Failed to save settings."`
    vi.spyOn(configApi, "updateAdminConfig").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByTestId("branding-save-btn")).toBeInTheDocument());
    await userEvent.setup().click(screen.getByTestId("branding-save-btn"));
    await waitFor(() => expect(screen.getByText("Failed to save settings.")).toBeInTheDocument());
  });

  // --- Input interactions ---

  it("updates app name field on user input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("App name")).toBeInTheDocument());
    await user.clear(screen.getByLabelText("App name"));
    await user.type(screen.getByLabelText("App name"), "Changed Name");
    expect(screen.getByLabelText("App name")).toHaveValue("Changed Name");
  });

  it("updates logo URL field on user input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Logo URL")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Logo URL"), "https://cdn.example.com/logo.png");
    expect(screen.getByLabelText("Logo URL")).toHaveValue("https://cdn.example.com/logo.png");
  });

  it("updates primary colour text field on user input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Primary colour")).toBeInTheDocument());
    await user.clear(screen.getByLabelText("Primary colour"));
    await user.type(screen.getByLabelText("Primary colour"), "#abcdef");
    expect(screen.getByLabelText("Primary colour")).toHaveValue("#abcdef");
  });

  it("updates support email field on user input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Support email")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Support email"), "support@test.com");
    expect(screen.getByLabelText("Support email")).toHaveValue("support@test.com");
  });

  it("colour picker input syncs with text input state", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Primary colour picker")).toBeInTheDocument());
    // The colour picker and text input share state — both start with the loaded value
    const textInput = screen.getByLabelText("Primary colour");
    expect(textInput).toHaveValue("#005f73");
    await user.clear(textInput);
    await user.type(textInput, "#ff0000");
    expect(screen.getByLabelText("Primary colour picker")).toHaveValue("#ff0000");
  });

  it("colour picker change updates text input", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Primary colour picker")).toBeInTheDocument());
    const picker = screen.getByLabelText("Primary colour picker");
    // type="color" inputs are not keyboard-editable; use fireEvent.change to simulate picker selection
    fireEvent.change(picker, { target: { value: "#123456" } });
    expect(screen.getByLabelText("Primary colour")).toHaveValue("#123456");
  });

  it("colour picker falls back to default when text input holds an invalid hex", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Primary colour")).toBeInTheDocument());
    const textInput = screen.getByLabelText("Primary colour");
    // Type a partial/invalid hex into the text field — this would be rejected by type="color"
    await user.clear(textInput);
    await user.type(textInput, "#abc");
    // Picker must fall back to the safe default so browsers don't ignore the value prop
    expect(screen.getByLabelText("Primary colour picker")).toHaveValue("#005f73");
    // Text input still shows what the user typed
    expect(textInput).toHaveValue("#abc");
  });

  // --- Logo file upload ---

  it("renders the Upload logo image file input", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());
  });

  it("uploading a valid file populates the logo URL field with the returned URL", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const blobUrl = "https://public.blob.vercel-storage.com/logo-test.png";
    const file = new File(["fake-png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() =>
      expect(screen.getByLabelText("Logo URL")).toHaveValue(blobUrl)
    );
  });

  it("shows Uploading message during upload then hides it on success", async () => {
    const user = userEvent.setup();
    // Delay the upload response so we can observe the Uploading state
    server.use(
      http.post("http://localhost/api/admin/config/logo", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ url: "https://public.blob.vercel-storage.com/logo.png" });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    // "Uploading…" appears while in flight
    expect(screen.getByText("Uploading…")).toBeInTheDocument();

    // After the response, "Uploading…" disappears
    await waitFor(() =>
      expect(screen.queryByText("Uploading…")).not.toBeInTheDocument()
    );
  });

  it("disables file input during upload", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("http://localhost/api/admin/config/logo", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ url: "https://public.blob.vercel-storage.com/logo.png" });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    expect(screen.getByLabelText("Upload logo image")).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByLabelText("Upload logo image")).not.toBeDisabled()
    );
  });

  it("shows upload error when server returns an error", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("http://localhost/api/admin/config/logo", () =>
        HttpResponse.json({ detail: "Logo upload failed" }, { status: 502 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() =>
      expect(screen.getByText(/HTTP 502/)).toBeInTheDocument()
    );
  });

  it("shows fallback upload error for non-Error thrown value", async () => {
    vi.spyOn(configApi, "uploadLogo").mockRejectedValueOnce("plain string error");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() =>
      expect(screen.getByText("Failed to upload logo.")).toBeInTheDocument()
    );
  });

  it("no-ops when file input changes with no file selected", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    // Fire change event with an empty file list
    fireEvent.change(screen.getByLabelText("Upload logo image"), { target: { files: [] } });

    // No uploading state, no error
    expect(screen.queryByText("Uploading…")).not.toBeInTheDocument();
  });

  // --- Favicon URL field ---

  it("renders the favicon URL field after loading", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Favicon URL")).toBeInTheDocument());
  });

  it("populates favicon URL field with loaded config value", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config`, () =>
        HttpResponse.json({ app_name: "Test", logo_url: "", favicon_url: "https://example.com/fav.png", primary_colour: "#005f73", support_email: "" })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Favicon URL")).toHaveValue("https://example.com/fav.png"));
  });

  it("does not show favicon preview when favicon_url is null", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config`, () =>
        HttpResponse.json({ app_name: "Test", logo_url: "", favicon_url: null, primary_colour: "#005f73", support_email: "" })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Favicon URL")).toBeInTheDocument());
  });

  it("updates favicon URL field on user input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Favicon URL")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Favicon URL"), "https://cdn.example.com/fav.ico");
    expect(screen.getByLabelText("Favicon URL")).toHaveValue("https://cdn.example.com/fav.ico");
  });

  it("clears favicon_url to null when field is cleared", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config`, () =>
        HttpResponse.json({ app_name: "Test", logo_url: "", favicon_url: "https://example.com/fav.png", primary_colour: "#005f73", support_email: "" })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Favicon URL")).toHaveValue("https://example.com/fav.png"));
    await user.clear(screen.getByLabelText("Favicon URL"));
    expect(screen.getByLabelText("Favicon URL")).toHaveValue("");
  });

  it("includes favicon_url in save payload", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(configApi, "updateAdminConfig");
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Favicon URL")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Favicon URL"), "https://cdn.example.com/fav.ico");
    await user.click(screen.getByTestId("branding-save-btn"));
    await waitFor(() => expect(screen.getByText("Settings saved.")).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ favicon_url: "https://cdn.example.com/fav.ico" })
    );
  });

  // --- Favicon file upload ---

  it("renders the Upload favicon image file input", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());
  });

  it("uploading a valid favicon file populates the favicon URL field with the returned URL", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const blobUrl = "https://public.blob.vercel-storage.com/favicon-test.png";
    const file = new File(["fake-png"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    await waitFor(() =>
      expect(screen.getByLabelText("Favicon URL")).toHaveValue(blobUrl)
    );
  });

  it("shows Uploading message during favicon upload then hides it on success", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("http://localhost/api/admin/config/favicon", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ url: "https://public.blob.vercel-storage.com/favicon.png" });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const file = new File(["fake"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    // At least one "Uploading…" text visible (logo or favicon)
    expect(screen.getAllByText("Uploading…").length).toBeGreaterThan(0);

    await waitFor(() =>
      expect(screen.getByLabelText("Upload favicon image")).not.toBeDisabled()
    );
  });

  it("disables favicon file input during upload", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("http://localhost/api/admin/config/favicon", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ url: "https://public.blob.vercel-storage.com/favicon.png" });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const file = new File(["fake"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    expect(screen.getByLabelText("Upload favicon image")).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByLabelText("Upload favicon image")).not.toBeDisabled()
    );
  });

  it("shows upload error when favicon server returns an error", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("http://localhost/api/admin/config/favicon", () =>
        HttpResponse.json({ detail: "Favicon upload failed" }, { status: 502 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const file = new File(["fake"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    await waitFor(() =>
      expect(screen.getByText(/HTTP 502/)).toBeInTheDocument()
    );
  });

  it("shows fallback favicon upload error for non-Error thrown value", async () => {
    vi.spyOn(configApi, "uploadFavicon").mockRejectedValueOnce("plain string error");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const file = new File(["fake"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    await waitFor(() =>
      expect(screen.getByText("Failed to upload favicon.")).toBeInTheDocument()
    );
  });

  it("no-ops when favicon file input changes with no file selected", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Upload favicon image"), { target: { files: [] } });

    expect(screen.queryByText("Failed to upload favicon.")).not.toBeInTheDocument();
  });

  // --- Upload success feedback ---

  it("shows 'Logo uploaded successfully' after a successful logo upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake-png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() =>
      expect(screen.getByText("Logo uploaded successfully")).toBeInTheDocument()
    );
  });

  it("shows 'Favicon uploaded successfully' after a successful favicon upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const file = new File(["fake-png"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    await waitFor(() =>
      expect(screen.getByText("Favicon uploaded successfully")).toBeInTheDocument()
    );
  });

  it("shows 'Save settings to apply the changes' hint after logo upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake-png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() =>
      expect(screen.getByText("Save settings to apply the changes")).toBeInTheDocument()
    );
  });

  it("shows 'Save settings to apply the changes' hint after favicon upload", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());

    const file = new File(["fake-png"], "favicon.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file);

    await waitFor(() =>
      expect(screen.getByText("Save settings to apply the changes")).toBeInTheDocument()
    );
  });

  it("'Save settings to apply the changes' hint disappears after clicking Save", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake-png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() =>
      expect(screen.getByText("Save settings to apply the changes")).toBeInTheDocument()
    );

    await user.click(screen.getByTestId("branding-save-btn"));

    await waitFor(() =>
      expect(screen.queryByText("Save settings to apply the changes")).not.toBeInTheDocument()
    );
  });

  it("upload success messages have role='status' for accessibility", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());

    const file = new File(["fake-png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file);

    await waitFor(() => {
      const statuses = screen.getAllByRole("status");
      const texts = statuses.map((el) => el.textContent);
      expect(texts.some((t) => t?.includes("Logo uploaded successfully"))).toBe(true);
    });
  });

  it("logo upload success clears error state first", async () => {
    const user = userEvent.setup();
    // First trigger an error
    server.use(
      http.post("http://localhost/api/admin/config/logo", () =>
        HttpResponse.json({ detail: "Upload failed" }, { status: 502 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload logo image")).toBeInTheDocument());
    const file1 = new File(["fake1"], "logo1.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file1);
    await waitFor(() => expect(screen.getByText(/HTTP 502/)).toBeInTheDocument());

    // Now succeed on second upload with a different file object (avoids no-change event)
    server.use(
      http.post("http://localhost/api/admin/config/logo", () =>
        HttpResponse.json({ url: "https://public.blob.vercel-storage.com/logo-test.png" })
      )
    );
    const file2 = new File(["fake2"], "logo2.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload logo image"), file2);
    await waitFor(() => expect(screen.getByText("Logo uploaded successfully")).toBeInTheDocument());
    // Error should be gone
    expect(screen.queryByText(/HTTP 502/)).not.toBeInTheDocument();
  });

  it("favicon upload success clears favicon error state first", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("http://localhost/api/admin/config/favicon", () =>
        HttpResponse.json({ detail: "Upload failed" }, { status: 502 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Upload favicon image")).toBeInTheDocument());
    const file1 = new File(["fake1"], "favicon1.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file1);
    await waitFor(() => expect(screen.getByText(/HTTP 502/)).toBeInTheDocument());

    server.use(
      http.post("http://localhost/api/admin/config/favicon", () =>
        HttpResponse.json({ url: "https://public.blob.vercel-storage.com/favicon-test.png" })
      )
    );
    const file2 = new File(["fake2"], "favicon2.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload favicon image"), file2);
    await waitFor(() => expect(screen.getByText("Favicon uploaded successfully")).toBeInTheDocument());
    expect(screen.queryByText(/HTTP 502/)).not.toBeInTheDocument();
  });

  // --- Tab switching ---

  it("clicking Email Server tab shows SMTP form", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByText("Mail Server")).toBeInTheDocument());
    expect(screen.getByLabelText("Host")).toBeInTheDocument();
  });

  it("clicking User Management tab shows users section", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText("Admin Users")).toBeInTheDocument());
  });

  it("Email Server tab becomes active after click", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    expect(screen.getByRole("tab", { name: "Email Server" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "UI & Theme" })).toHaveAttribute("aria-selected", "false");
  });

  it("User Management tab becomes active after click", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    expect(screen.getByRole("tab", { name: "User Management" })).toHaveAttribute("aria-selected", "true");
  });

  it("branding form is hidden when Email Server tab is active", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    // The tab panel stays in the DOM (hidden attr) — assert not visible, not absent
    expect(screen.getByLabelText("App name")).not.toBeVisible();
  });

  it("clicking UI & Theme tab from Email Server tab restores branding form", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    // The tab panel stays in the DOM (hidden attr) — assert not visible while inactive
    expect(screen.getByLabelText("App name")).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: "UI & Theme" }));
    await waitFor(() => expect(screen.getByLabelText("App name")).toBeVisible());
    expect(screen.getByRole("tab", { name: "UI & Theme" })).toHaveAttribute("aria-selected", "true");
  });

  // --- Mail Server (SMTP) section ---

  it("updates SMTP port field on user input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByLabelText("Port")).toBeInTheDocument());
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "465");
    expect(portInput).toHaveValue(465);
  });

  it("renders Mail Server section after switching to Email Server tab", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByText("Mail Server")).toBeInTheDocument());
    expect(screen.getByLabelText("Host")).toBeInTheDocument();
    expect(screen.getByLabelText("Port")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("From email address")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("shows unconfigured notice when SMTP is not set up", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "",
          smtp_port: 587,
          smtp_username: "",
          smtp_from_email: "",
          password_is_set: false,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() =>
      expect(screen.getByText(/Mail server is not configured/)).toBeInTheDocument()
    );
  });

  it("does not show unconfigured notice when SMTP is configured", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByText("Mail Server")).toBeInTheDocument());
    expect(screen.queryByText(/Mail server is not configured/)).not.toBeInTheDocument();
  });

  it("saves SMTP settings and shows success message", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "",
          smtp_port: 587,
          smtp_username: "",
          smtp_from_email: "",
          password_is_set: false,
        })
      ),
      http.put(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByLabelText("Host")).toBeInTheDocument());

    await user.clear(screen.getByLabelText("Host"));
    await user.type(screen.getByLabelText("Host"), "smtp.example.com");
    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), "user");
    await user.clear(screen.getByLabelText("From email address"));
    await user.type(screen.getByLabelText("From email address"), "from@example.com");
    await user.type(screen.getByLabelText("Password"), "secret");

    await user.click(screen.getByTestId("smtp-save-btn"));

    await waitFor(() => expect(screen.getByText("SMTP settings saved.")).toBeInTheDocument());
  });

  it("shows error when SMTP save fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      ),
      http.put(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({ detail: "Validation error" }, { status: 422 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByLabelText("Host")).toHaveValue("smtp.example.com"));
    await user.click(screen.getByTestId("smtp-save-btn"));
    await waitFor(() => expect(screen.getByText(/HTTP 422|Validation error/)).toBeInTheDocument());
  });

  it("shows fallback error when SMTP save throws non-Error", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    vi.spyOn(configApi, "updateSmtpConfig").mockRejectedValueOnce("smtp string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByLabelText("Host")).toHaveValue("smtp.example.com"));
    await user.click(screen.getByTestId("smtp-save-btn"));
    await waitFor(() => expect(screen.getByText("Failed to save SMTP settings.")).toBeInTheDocument());
  });

  it("sends test email and shows success", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Recipient email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(/Test email sent to/)).toBeInTheDocument());
  });

  it("shows error when test email fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      ),
      http.post(`${BASE}/api/admin/config/smtp/test`, () =>
        HttpResponse.json({ detail: "Connection refused" }, { status: 400 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Recipient email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(/Connection refused/)).toBeInTheDocument());
  });

  it("Escape key closes test email modal", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());

    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    fireEvent.keyDown(overlay, { key: "Escape" });

    await waitFor(() => expect(screen.queryByLabelText("Recipient email")).not.toBeInTheDocument());
  });

  it("backdrop click closes test email modal", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());

    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    fireEvent.click(overlay);

    await waitFor(() => expect(screen.queryByLabelText("Recipient email")).not.toBeInTheDocument());
  });

  it("Cancel button closes test email modal", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByLabelText("Recipient email")).not.toBeInTheDocument());
  });

  it("shows fallback error when test email throws non-Error", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    vi.spyOn(configApi, "testSmtpConfig").mockRejectedValueOnce("smtp plain error");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Recipient email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Test email failed.")).toBeInTheDocument());
  });

  it("SMTP Save button shows Saving state while submitting", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      ),
      http.put(`${BASE}/api/admin/config/smtp`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByLabelText("Host")).toHaveValue("smtp.example.com"));
    await user.click(screen.getByTestId("smtp-save-btn"));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("smtp-save-btn")).not.toBeDisabled());
  });

  it("Send test email shows Sending state while in-flight", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      ),
      http.post(`${BASE}/api/admin/config/smtp/test`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ ok: true });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test email" })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(screen.getByLabelText("Recipient email")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Recipient email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/Test email sent to/)).toBeInTheDocument());
  });

  it("SMTP success message disappears after 3 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () =>
        HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: true,
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Email Server" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Email Server" }));
    await waitFor(() => expect(screen.getByLabelText("Host")).toHaveValue("smtp.example.com"));
    await user.click(screen.getByTestId("smtp-save-btn"));
    await waitFor(() => expect(screen.getByText("SMTP settings saved.")).toBeInTheDocument());
    act(() => vi.advanceTimersByTime(3100));
    await waitFor(() => expect(screen.queryByText("SMTP settings saved.")).not.toBeInTheDocument());
    vi.useRealTimers();
  });

  // --- User Management tab ---

  it("switching away and back to User Management tab does not re-fetch users", async () => {
    // Exercises the hasFetchedUsers.current guard: the second tab activation must
    // NOT trigger a second GET /api/admin/users request.
    const user = userEvent.setup();
    let fetchCount = 0;
    server.use(
      http.get(`${BASE}/api/admin/users`, () => {
        fetchCount++;
        return HttpResponse.json({ users: [ADMIN_USER_CURRENT] });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());

    // First activation — triggers fetch
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeInTheDocument());
    expect(fetchCount).toBe(1);

    // Switch away, then back — must NOT trigger a second fetch
    await user.click(screen.getByRole("tab", { name: "UI & Theme" }));
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    // Give any potential async work a moment to complete
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeVisible());
    expect(fetchCount).toBe(1);
  });

  it("shows loading state while fetching users", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/users`, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return HttpResponse.json({ users: [] });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    expect(screen.getByText("Loading users…")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading users…")).not.toBeInTheDocument());
  });

  it("renders user table with email and created date after loading", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeInTheDocument());
    expect(screen.getByText(ADMIN_USER_OTHER.email)).toBeInTheDocument();
    // Check created date is formatted
    const expectedDate = new Date(ADMIN_USER_CURRENT.created_at).toLocaleDateString("en-AU");
    expect(screen.getByText(expectedDate)).toBeInTheDocument();
  });

  it("shows (you) marker on current user row", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeInTheDocument());
    expect(screen.getByText("(you)")).toBeInTheDocument();
  });

  it("hides Remove button for current user row", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeInTheDocument());
    // Only one Remove button (for the other user), not two
    const removeBtns = screen.getAllByRole("button", { name: "Remove" });
    expect(removeBtns).toHaveLength(1);
  });

  it("shows Remove button for other user rows", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_OTHER.email)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("shows empty state when no users returned", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/users`, () => HttpResponse.json({ users: [] }))
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText("No admin users found.")).toBeInTheDocument());
  });

  it("shows error state when users fetch fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/users`, () =>
        HttpResponse.json({ detail: "Not configured" }, { status: 503 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText("Failed to load users.")).toBeInTheDocument());
  });

  it("shows Invite Admin button on User Management tab", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
  });

  it("clicking Invite Admin opens the invite modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    // Modal is not visible before clicking
    expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    // Modal is now visible
    const modal = screen.getByRole("dialog", { name: "Invite Admin User" });
    expect(modal).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Invite" })).toBeInTheDocument();
  });

  it("Cancel button closes the invite modal without calling API", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(usersApi, "inviteAdminUser");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Invite Admin User" })).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("Escape key closes the invite modal without calling API", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(usersApi, "inviteAdminUser");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Invite Admin User" })).toBeInTheDocument());
    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    fireEvent.keyDown(overlay, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  it("backdrop click closes the invite modal without calling API", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(usersApi, "inviteAdminUser");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Invite Admin User" })).toBeInTheDocument());
    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  it("invite flow: UI has NOT transitioned while async invite is pending, and HAS transitioned after it completes", async () => {
    // Assert that modal stays open (email field visible) during the request and closes only after success.
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ id: "new-id", email: "pending@example.com", created_at: new Date().toISOString() }, { status: 201 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "pending@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invite" }));
    // While in-flight: modal still open, success NOT yet shown
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.queryByText(/Invite sent to/)).not.toBeInTheDocument();
    // After completion: modal closes and success message appears
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument());
    expect(screen.getByText(/Invite sent to pending@example.com/)).toBeInTheDocument();
  });

  it("invite flow: submitting valid email shows success and new user in table", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "newuser@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invite" }));
    await waitFor(() => expect(screen.getByText(/Invite sent to newuser@example.com/)).toBeInTheDocument());
    // New user should appear in table
    expect(screen.getByText("newuser@example.com")).toBeInTheDocument();
    // Modal is closed after success
    expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument();
  });

  it("invite flow: 409 duplicate shows inline error in modal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "duplicate@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invite" }));
    await waitFor(() =>
      expect(screen.getByText("A user with that email already exists.")).toBeInTheDocument()
    );
    // Modal stays open to allow correction
    expect(screen.getByRole("dialog", { name: "Invite Admin User" })).toBeInTheDocument();
  });

  it("invite flow: Send Invite button is disabled while in flight", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ id: "new-id", email: "slow@example.com", created_at: new Date().toISOString() }, { status: 201 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "slow@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invite" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/Invite sent to slow@example.com/)).toBeInTheDocument());
  });

  it("invite flow: fallback error for non-Error thrown value", async () => {
    const user = userEvent.setup();
    vi.spyOn(usersApi, "inviteAdminUser").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByLabelText("Email address")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invite" }));
    await waitFor(() => expect(screen.getByText("Failed to send invite.")).toBeInTheDocument());
  });

  it("remove flow: clicking Remove shows confirmation dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    expect(dialog).toBeInTheDocument();
    // The dialog body mentions the email in a <strong> tag
    expect(dialog.querySelector("strong")?.textContent).toBe(ADMIN_USER_OTHER.email);
  });

  it("remove flow: Cancel in confirmation closes dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    // Cancel is inside the dialog
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Remove user?" })).not.toBeInTheDocument();
  });

  it("remove flow: Escape key closes confirmation dialog without removing user", async () => {
    const spy = vi.spyOn(usersApi, "removeAdminUser");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Remove user?" })).toBeInTheDocument());
    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    // Non-Escape keydown must NOT close the dialog (covers the false branch)
    fireEvent.keyDown(overlay, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Remove user?" })).toBeInTheDocument();
    // Escape keydown closes the dialog
    fireEvent.keyDown(overlay, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove user?" })).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  it("remove flow: overlay click closes confirmation dialog without removing user", async () => {
    const spy = vi.spyOn(usersApi, "removeAdminUser");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Remove user?" })).toBeInTheDocument());
    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove user?" })).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  it("remove flow: confirming removes user row and shows success", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    // Confirm removal using the dialog's danger button
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("User removed.")).toBeInTheDocument());
    expect(screen.queryByText(ADMIN_USER_OTHER.email)).not.toBeInTheDocument();
  });

  it("remove flow: 409 last admin shows inline error", async () => {
    const user = userEvent.setup();
    server.use(
      http.delete(`${BASE}/api/admin/users/:userId`, () =>
        HttpResponse.json({ detail: "Cannot remove the last admin user." }, { status: 409 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(screen.getByText("Cannot remove the last admin user.")).toBeInTheDocument()
    );
  });

  it("remove flow: 403 self-removal shows inline error", async () => {
    const user = userEvent.setup();
    server.use(
      http.delete(`${BASE}/api/admin/users/:userId`, () =>
        HttpResponse.json({ detail: "Cannot remove yourself." }, { status: 403 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(screen.getByText("Cannot remove yourself.")).toBeInTheDocument()
    );
  });

  it("remove flow: UI has NOT transitioned while async removal is pending, and HAS transitioned after it completes", async () => {
    // This test asserts the async UI transition: while removal is in-flight the
    // Remove button is disabled and the success message has NOT appeared; after
    // the request completes the user row is gone and the success message shows.
    const user = userEvent.setup();
    server.use(
      http.delete(`${BASE}/api/admin/users/:userId`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return new HttpResponse(null, { status: 204 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    // Immediately after confirm: dialog is gone, but success message has NOT appeared yet
    expect(screen.queryByRole("dialog", { name: "Remove user?" })).not.toBeInTheDocument();
    expect(screen.queryByText("User removed.")).not.toBeInTheDocument();
    // After the request completes, success message appears and user row is gone
    await waitFor(() => expect(screen.getByText("User removed.")).toBeInTheDocument());
    expect(screen.queryByText(ADMIN_USER_OTHER.email)).not.toBeInTheDocument();
  });

  it("remove flow: fallback error for non-Error thrown value", async () => {
    const user = userEvent.setup();
    vi.spyOn(usersApi, "removeAdminUser").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("Failed to remove user.")).toBeInTheDocument());
  });

  it("shows all users as non-current when session returns null user", async () => {
    // Exercises the `?? null` branch on line 99 — session has no user id
    vi.mocked(authClient.getSession).mockResolvedValueOnce(null as never);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeInTheDocument());
    // With no current user id, no "(you)" marker should be shown
    expect(screen.queryByText("(you)")).not.toBeInTheDocument();
    // Both users should show Remove buttons
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });

  it("multi-step: invite then remove full sequence", async () => {
    const user = userEvent.setup();
    renderPage();
    // Navigate to User Management
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite Admin" })).toBeInTheDocument());

    // Step 1: Invite a user via modal
    await user.click(screen.getByRole("button", { name: "Invite Admin" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Invite Admin User" })).toBeInTheDocument());
    await user.type(screen.getByLabelText("Email address"), "sequence@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invite" }));
    await waitFor(() => expect(screen.getByText(/Invite sent to sequence@example.com/)).toBeInTheDocument());
    expect(screen.getByText("sequence@example.com")).toBeInTheDocument();
    // Modal should be closed after successful invite
    expect(screen.queryByRole("dialog", { name: "Invite Admin User" })).not.toBeInTheDocument();

    // Step 2: Remove the newly invited user
    // The new user row has a Remove button (it's not the current user)
    // Find Remove button for the newly added user row by querying all Remove buttons
    const removeBtns = screen.getAllByRole("button", { name: "Remove" });
    // Click the last Remove button which belongs to the newly added user
    await user.click(removeBtns[removeBtns.length - 1]);
    const dialog = screen.getByRole("dialog", { name: "Remove user?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("User removed.")).toBeInTheDocument());
    expect(screen.queryByText("sequence@example.com")).not.toBeInTheDocument();
  });

  // --- Change Password ---

  async function openChangePasswordModal() {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change Password" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Change Password" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Change Password" })).toBeInTheDocument());
    return user;
  }

  it("shows Change Password button in the current user's row (not in the header)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_CURRENT.email)).toBeInTheDocument());
    // The button exists exactly once
    const btn = screen.getByRole("button", { name: "Change Password" });
    expect(btn).toBeInTheDocument();
    // It is inside the current user's row, not in the card header
    const currentUserRow = btn.closest("tr");
    expect(currentUserRow).not.toBeNull();
    expect(currentUserRow).toHaveTextContent(ADMIN_USER_CURRENT.email);
  });

  it("other users' rows do not have a Change Password button", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "User Management" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "User Management" }));
    await waitFor(() => expect(screen.getByText(ADMIN_USER_OTHER.email)).toBeInTheDocument());
    // Find the other user's row and confirm no Change Password button inside it
    const otherUserCells = screen.getByText(ADMIN_USER_OTHER.email).closest("tr");
    expect(otherUserCells).not.toBeNull();
    expect(within(otherUserCells!).queryByRole("button", { name: "Change Password" })).not.toBeInTheDocument();
  });

  it("clicking Change Password opens the modal with required fields", async () => {
    await openChangePasswordModal();
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("modal has role=dialog, aria-modal, and aria-labelledby pointing to heading", async () => {
    await openChangePasswordModal();
    const dialog = screen.getByRole("dialog", { name: "Change Password" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "change-password-modal-title");
    expect(screen.getByText("Change Password", { selector: "#change-password-modal-title" })).toBeInTheDocument();
  });

  it("shows password requirements checklist in the Change Password modal", async () => {
    await openChangePasswordModal();
    expect(screen.getByRole("list", { name: "Password requirements" })).toBeInTheDocument();
  });

  it("Update Password button is disabled when fields are empty", async () => {
    await openChangePasswordModal();
    expect(screen.getByRole("button", { name: "Update Password" })).toBeDisabled();
  });

  it("Update Password button is disabled when new password does not meet requirements", async () => {
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "short");
    expect(screen.getByRole("button", { name: "Update Password" })).toBeDisabled();
  });

  it("Update Password button is disabled when passwords do not match", async () => {
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass2!");
    expect(screen.getByRole("button", { name: "Update Password" })).toBeDisabled();
  });

  it("shows confirm mismatch error when confirm differs from new password", async () => {
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "Different1!");
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
  });

  it("does not show confirm mismatch error when confirm field is empty", async () => {
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    // confirm field left empty
    expect(screen.queryByText("Passwords do not match.")).not.toBeInTheDocument();
  });

  it("Update Password button is enabled when all fields are valid and passwords match", async () => {
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    expect(screen.getByRole("button", { name: "Update Password" })).not.toBeDisabled();
  });

  it("successful password change closes modal and shows success message", async () => {
    vi.mocked(changePasswordFn).mockResolvedValueOnce({ error: null } as never);
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Password" })).not.toBeInTheDocument());
    expect(screen.getByText("Password updated successfully.")).toBeInTheDocument();
  });

  it("modal has NOT closed while change-password call is pending, and HAS closed after it completes", async () => {
    let resolve!: (value: { error: null }) => void;
    vi.mocked(changePasswordFn).mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    ) as never;
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    // While pending: modal still open, success NOT yet shown
    expect(screen.getByRole("dialog", { name: "Change Password" })).toBeInTheDocument();
    expect(screen.queryByText("Password updated successfully.")).not.toBeInTheDocument();
    // Complete the call
    resolve({ error: null });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Password" })).not.toBeInTheDocument());
    expect(screen.getByText("Password updated successfully.")).toBeInTheDocument();
  });

  it("wrong current password shows inline error inside modal", async () => {
    vi.mocked(changePasswordFn).mockResolvedValueOnce({
      error: { message: "Invalid current password." },
    } as never);
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "WrongPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Invalid current password.")).toBeInTheDocument();
    // Modal stays open
    expect(screen.getByRole("dialog", { name: "Change Password" })).toBeInTheDocument();
  });

  it("changePassword error without message shows fallback error", async () => {
    vi.mocked(changePasswordFn).mockResolvedValueOnce({
      error: {},
    } as never);
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Failed to change password.")).toBeInTheDocument();
  });

  it("changePassword throws shows fallback error", async () => {
    vi.mocked(changePasswordFn).mockRejectedValueOnce(new Error("Network error")) as never;
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Failed to change password. Please try again.")).toBeInTheDocument();
  });

  it("Cancel button closes the Change Password modal", async () => {
    const user = await openChangePasswordModal();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Password" })).not.toBeInTheDocument());
  });

  it("Escape key closes the Change Password modal", async () => {
    await openChangePasswordModal();
    const overlay = document.querySelector(".dialog-overlay") as HTMLElement;
    fireEvent.keyDown(overlay, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Password" })).not.toBeInTheDocument());
  });

  it("backdrop click closes the Change Password modal", async () => {
    await openChangePasswordModal();
    // Click the overlay that wraps the dialog — use the last dialog-overlay in the DOM
    const overlays = document.querySelectorAll(".dialog-overlay");
    const overlay = overlays[overlays.length - 1] as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Password" })).not.toBeInTheDocument());
  });

  it("Update Password button shows Updating… while in flight", async () => {
    let resolve!: (value: { error: null }) => void;
    vi.mocked(changePasswordFn).mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    ) as never;
    const user = await openChangePasswordModal();
    await user.type(screen.getByLabelText("Current password"), "OldPass1!");
    await user.type(screen.getByLabelText("New password"), "NewPass1!");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPass1!");
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    resolve({ error: null });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change Password" })).not.toBeInTheDocument());
  });

  // --- Subscription tab ---

  it("renders Subscription tab button", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
  });

  it("clicking Subscription tab activates it", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    expect(screen.getByRole("tab", { name: "Subscription" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "UI & Theme" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows loading state while fetching subscription", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/subscription`, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    // The subscription tab panel should show loading
    expect(screen.getByText("Loading subscription…")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading subscription…")).not.toBeInTheDocument());
  });

  it("displays subscription data after loading", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Pro", building_limit: 20, active_building_count: 5 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByText("Pro")).toBeInTheDocument());
    expect(screen.getByText(/5 \/ 20 buildings/)).toBeInTheDocument();
  });

  it("shows 'No plan set' when tier_name is null", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: null, building_limit: null, active_building_count: 2 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByText("No plan set")).toBeInTheDocument());
  });

  it("shows 'Unlimited' when building_limit is null", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ tier_name: "Enterprise", building_limit: null, active_building_count: 10 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByText(/Unlimited/)).toBeInTheDocument());
  });

  it("shows error when subscription fetch fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () =>
        HttpResponse.json({ detail: "Forbidden" }, { status: 403 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByText("Failed to load subscription.")).toBeInTheDocument());
  });

  it("shows tier change request section after subscription loads", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
  });

  it("switching away and back to Subscription tab does not re-fetch subscription", async () => {
    // Exercises the hasFetchedSubscription.current guard: second activation must not re-fetch.
    const user = userEvent.setup();
    let fetchCount = 0;
    server.use(
      http.get(`${BASE}/api/admin/subscription`, () => {
        fetchCount++;
        return HttpResponse.json({ tier_name: "Starter", building_limit: 10, active_building_count: 3 });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());

    // First activation — triggers fetch; tier display is a <dd> element
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    // Verify tier is shown in the definition list (not in the select options)
    await waitFor(() => {
      const dds = screen.getAllByRole("definition");
      expect(dds[0]).toHaveTextContent("Starter");
    });
    expect(fetchCount).toBe(1);

    // Switch away then back — must NOT trigger a second fetch
    await user.click(screen.getByRole("tab", { name: "UI & Theme" }));
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => {
      const dds = screen.getAllByRole("definition");
      expect(dds[0]).toHaveTextContent("Starter");
    });
    expect(fetchCount).toBe(1);
  });

  it("subscription fetch error uses fallback for non-Error thrown value", async () => {
    const user = userEvent.setup();
    vi.spyOn(subscriptionApi, "getSubscription").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByText("Failed to load subscription.")).toBeInTheDocument());
  });

  // --- Tier change request ---

  it("tier change request section renders select and Send request button", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
  });

  it("Send request button is disabled when no tier is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  });

  it("Send request button is enabled when a tier is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Requested tier" }), "Growth");
    expect(screen.getByRole("button", { name: "Send request" })).not.toBeDisabled();
  });

  it("tier change request: shows success message and resets select on success", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Requested tier" }), "Enterprise");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() =>
      expect(screen.getByText("Request sent. We'll be in touch.")).toBeInTheDocument()
    );
    // Select is reset to placeholder after success
    expect(screen.getByRole("combobox", { name: "Requested tier" })).toHaveValue("");
  });

  it("tier change request: UI has NOT transitioned while request is pending, HAS transitioned after it completes", async () => {
    // Async transition test: verifies fire-and-forget would fail this test
    const user = userEvent.setup();
    let resolveRequest!: () => void;
    server.use(
      http.post(`${BASE}/api/admin/subscription/request-change`, () =>
        new Promise<Response>((resolve) => {
          resolveRequest = () => resolve(HttpResponse.json({ message: "Request sent." }) as unknown as Response);
        })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Requested tier" }), "Starter");
    await user.click(screen.getByRole("button", { name: "Send request" }));

    // While pending — success message must NOT be visible yet
    expect(screen.queryByText("Request sent. We'll be in touch.")).not.toBeInTheDocument();

    // Complete the request
    resolveRequest();
    await waitFor(() =>
      expect(screen.getByText("Request sent. We'll be in touch.")).toBeInTheDocument()
    );
  });

  it("tier change request: shows error message on API failure", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/api/admin/subscription/request-change`, () =>
        HttpResponse.json({ detail: "SMTP not configured" }, { status: 503 })
      )
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Requested tier" }), "Growth");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("tier change request: shows fallback error for non-Error thrown value", async () => {
    const user = userEvent.setup();
    vi.spyOn(subscriptionApi, "requestSubscriptionChange").mockRejectedValueOnce("plain string error");
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Requested tier" }), "Free");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.getByText("Failed to send request.")).toBeInTheDocument());
  });

  it("tier change request: Send request button is disabled while submitting", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${BASE}/api/admin/subscription/request-change`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ message: "Request sent." });
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox", { name: "Requested tier" }), "Expansion");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    // After completion the select is reset to empty so the button remains disabled;
    // verify the async work completed by checking the success message appears.
    await waitFor(() => expect(screen.getByText("Request sent. We'll be in touch.")).toBeInTheDocument());
  });

  // --- Tier picker option labels ---

  it("tier change select shows building limit labels in options", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Subscription" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Subscription" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Requested tier" })).toBeInTheDocument());
    const select = screen.getByRole("combobox", { name: "Requested tier" }) as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.text);
    expect(optionTexts).toContain("Free (1 building)");
    expect(optionTexts).toContain("Starter (up to 10 buildings)");
    expect(optionTexts).toContain("Growth (up to 25 buildings)");
    expect(optionTexts).toContain("Expansion (up to 50 buildings)");
    expect(optionTexts).toContain("Enterprise (unlimited)");
  });

  // --- Mobile horizontal scroll (Change 2) ---

  it("settings tab list has overflowX auto for mobile scroll", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveStyle({ overflowX: "auto" });
  });

  // --- SMS tab ---

  it("renders SMS tab button", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
  });

  it("clicking SMS tab activates it and shows SMS settings panel", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    expect(screen.getByRole("tab", { name: "SMS" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: /SMS/i })).not.toHaveAttribute("hidden");
  });

  it("SMS panel has 'SMS Settings' heading", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    expect(screen.getByText("SMS Settings")).toBeInTheDocument();
  });

  it("SMS panel renders Enable SMS OTP checkbox unchecked by default", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const checkbox = screen.getByLabelText("Enable SMS OTP");
    expect(checkbox).not.toBeChecked();
  });

  it("SMS panel renders provider select with correct options", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const select = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("");
    expect(options).toContain("smtp2go");
    expect(options).toContain("twilio");
    expect(options).toContain("clicksend");
    expect(options).toContain("webhook");
  });

  it("selecting smtp2go provider shows smtp2go-specific fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "smtp2go");
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.getByLabelText("Sender number")).toBeInTheDocument();
  });

  it("selecting twilio provider shows twilio-specific fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "twilio");
    expect(screen.getByLabelText("Account SID")).toBeInTheDocument();
    expect(screen.getByLabelText("Auth token")).toBeInTheDocument();
    expect(screen.getByLabelText("From number")).toBeInTheDocument();
  });

  it("selecting clicksend provider shows clicksend-specific fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const smsPanel = screen.getByRole("tabpanel", { name: /SMS/i });
    await user.selectOptions(within(smsPanel).getByRole("combobox", { name: "Provider" }), "clicksend");
    expect(within(smsPanel).getByLabelText("Username")).toBeInTheDocument();
    expect(within(smsPanel).getByLabelText("API key")).toBeInTheDocument();
    expect(within(smsPanel).getByLabelText("From number")).toBeInTheDocument();
  });

  it("selecting webhook provider shows webhook-specific fields", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "webhook");
    expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook secret (optional)")).toBeInTheDocument();
  });

  it("smtp2go fields are NOT shown when no provider is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sender number")).not.toBeInTheDocument();
  });

  it("twilio fields are NOT shown when smtp2go is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "smtp2go");
    expect(screen.queryByLabelText("Account SID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Auth token")).not.toBeInTheDocument();
  });

  it("saves SMS settings and shows success message", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => {
      expect(screen.getByText("SMS settings saved.")).toBeInTheDocument();
    });
  });

  it("SMS settings save: UI has NOT transitioned while pending, HAS transitioned after complete", async () => {
    let resolveRequest!: (value: Response) => void;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, () =>
        new Promise<Response>((resolve) => { resolveRequest = resolve; })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByTestId("sms-save-btn"));
    // Button should show Saving… while pending
    expect(screen.getByTestId("sms-save-btn")).toHaveTextContent("Saving…");
    expect(screen.queryByText("SMS settings saved.")).not.toBeInTheDocument();
    // Resolve the request
    await act(async () => {
      resolveRequest(HttpResponse.json({
        sms_enabled: false,
        sms_provider: null,
        smtp2go_api_key_is_set: false,
        smtp2go_sender_number: "",
        twilio_account_sid: "",
        twilio_auth_token_is_set: false,
        twilio_from_number: "",
        clicksend_username: "",
        clicksend_api_key_is_set: false,
        clicksend_from_number: "",
        webhook_url: "",
        webhook_secret_is_set: false,
      }) as unknown as Response);
    });
    await waitFor(() => expect(screen.getByText("SMS settings saved.")).toBeInTheDocument());
  });

  it("shows error when SMS save fails", async () => {
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, () =>
        HttpResponse.json({ detail: "Save failed" }, { status: 500 })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => {
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });
  });

  it("test SMS section is NOT shown when sms_enabled is false", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    expect(screen.queryByText("Send test SMS")).not.toBeInTheDocument();
  });

  it("test SMS section IS shown when sms_enabled checkbox is checked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    // The test section heading "Send test SMS" and the button both appear; check the button
    expect(screen.getByRole("button", { name: "Send test SMS" })).toBeInTheDocument();
  });

  it("test SMS section shows phone input and send button", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    expect(screen.getByLabelText("Phone number")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test SMS" })).toBeInTheDocument();
  });

  it("Send test SMS button is disabled when phone input is empty", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    expect(screen.getByRole("button", { name: "Send test SMS" })).toBeDisabled();
  });

  it("Send test SMS calls endpoint and shows success message", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    await user.type(screen.getByLabelText("Phone number"), "+61412345678");
    await user.click(screen.getByRole("button", { name: "Send test SMS" }));
    await waitFor(() => {
      expect(screen.getByText("Test SMS sent to +61412345678")).toBeInTheDocument();
    });
  });

  it("Send test SMS shows error message on failure", async () => {
    server.use(
      http.post(`${BASE}/api/admin/settings/sms/test`, () =>
        HttpResponse.json({ detail: "Send failed" }, { status: 500 })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    await user.type(screen.getByLabelText("Phone number"), "+61412345678");
    await user.click(screen.getByRole("button", { name: "Send test SMS" }));
    await waitFor(() => {
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });
  });

  it("SMS settings loaded from API on mount: enabled checkbox reflects fixture", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/sms`, () =>
        HttpResponse.json({
          sms_enabled: true,
          sms_provider: "twilio",
          smtp2go_api_key_is_set: false,
          smtp2go_sender_number: "",
          twilio_account_sid: "AC123",
          twilio_auth_token_is_set: true,
          twilio_from_number: "+61400000000",
          clicksend_username: "",
          clicksend_api_key_is_set: false,
          clicksend_from_number: "",
          webhook_url: "",
          webhook_secret_is_set: false,
        })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    expect(screen.getByLabelText("Enable SMS OTP")).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("twilio");
    expect(screen.getByLabelText("Account SID")).toHaveValue("AC123");
    expect(screen.getByLabelText("From number")).toHaveValue("+61400000000");
  });

  it("SMS save with twilio provider: includes twilio fields in payload", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true,
          sms_provider: "twilio",
          smtp2go_api_key_is_set: false,
          smtp2go_sender_number: "",
          twilio_account_sid: "AC999",
          twilio_auth_token_is_set: true,
          twilio_from_number: "+61411111111",
          clicksend_username: "",
          clicksend_api_key_is_set: false,
          clicksend_from_number: "",
          webhook_url: "",
          webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "twilio");
    await user.type(screen.getByLabelText("Account SID"), "AC999");
    await user.type(screen.getByLabelText("Auth token"), "secret-token");
    await user.type(screen.getByLabelText("From number"), "+61411111111");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.sms_provider).toBe("twilio");
    expect(capturedBody?.twilio_account_sid).toBe("AC999");
    expect(capturedBody?.twilio_auth_token).toBe("secret-token");
    expect(capturedBody?.twilio_from_number).toBe("+61411111111");
  });

  it("SMS save with smtp2go provider: includes smtp2go fields in payload", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true,
          sms_provider: "smtp2go",
          smtp2go_api_key_is_set: true,
          smtp2go_sender_number: "+61400001111",
          twilio_account_sid: "",
          twilio_auth_token_is_set: false,
          twilio_from_number: "",
          clicksend_username: "",
          clicksend_api_key_is_set: false,
          clicksend_from_number: "",
          webhook_url: "",
          webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "smtp2go");
    await user.type(screen.getByLabelText("API key"), "my-api-key");
    await user.type(screen.getByLabelText("Sender number"), "+61400001111");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.sms_provider).toBe("smtp2go");
    expect(capturedBody?.smtp2go_api_key).toBe("my-api-key");
    expect(capturedBody?.smtp2go_sender_number).toBe("+61400001111");
  });

  it("SMS save with clicksend provider: includes clicksend fields in payload", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true,
          sms_provider: "clicksend",
          smtp2go_api_key_is_set: false,
          smtp2go_sender_number: "",
          twilio_account_sid: "",
          twilio_auth_token_is_set: false,
          twilio_from_number: "",
          clicksend_username: "user@example.com",
          clicksend_api_key_is_set: true,
          clicksend_from_number: "+61400002222",
          webhook_url: "",
          webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const smsPanel = screen.getByRole("tabpanel", { name: /SMS/i });
    await user.click(within(smsPanel).getByLabelText("Enable SMS OTP"));
    await user.selectOptions(within(smsPanel).getByRole("combobox", { name: "Provider" }), "clicksend");
    await user.type(within(smsPanel).getByLabelText("Username"), "user@example.com");
    await user.type(within(smsPanel).getByLabelText("API key"), "cs-api-key");
    await user.type(within(smsPanel).getByLabelText("From number"), "+61400002222");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.sms_provider).toBe("clicksend");
    expect(capturedBody?.clicksend_username).toBe("user@example.com");
    expect(capturedBody?.clicksend_api_key).toBe("cs-api-key");
    expect(capturedBody?.clicksend_from_number).toBe("+61400002222");
  });

  it("SMS save with webhook provider: includes webhook fields in payload", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true,
          sms_provider: "webhook",
          smtp2go_api_key_is_set: false,
          smtp2go_sender_number: "",
          twilio_account_sid: "",
          twilio_auth_token_is_set: false,
          twilio_from_number: "",
          clicksend_username: "",
          clicksend_api_key_is_set: false,
          clicksend_from_number: "",
          webhook_url: "https://example.com/sms",
          webhook_secret_is_set: true,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "webhook");
    await user.type(screen.getByLabelText("Webhook URL"), "https://example.com/sms");
    await user.type(screen.getByLabelText("Webhook secret (optional)"), "my-secret");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.sms_provider).toBe("webhook");
    expect(capturedBody?.webhook_url).toBe("https://example.com/sms");
    expect(capturedBody?.webhook_secret).toBe("my-secret");
  });

  it("getSmsConfig load failure shows error message", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/sms`, () =>
        HttpResponse.json({ detail: "Server error" }, { status: 500 })
      )
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Failed to load settings.")).toBeInTheDocument();
    });
  });

  it("SMS save with smtp2go: omits api_key from payload when field is empty", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true, sms_provider: "smtp2go",
          smtp2go_api_key_is_set: true, smtp2go_sender_number: "+61400001111",
          twilio_account_sid: "", twilio_auth_token_is_set: false, twilio_from_number: "",
          clicksend_username: "", clicksend_api_key_is_set: false, clicksend_from_number: "",
          webhook_url: "", webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const smsPanel = screen.getByRole("tabpanel", { name: /SMS/i });
    await user.click(within(smsPanel).getByLabelText("Enable SMS OTP"));
    await user.selectOptions(within(smsPanel).getByRole("combobox", { name: "Provider" }), "smtp2go");
    // Leave API key empty — tests the falsy branch
    await user.type(within(smsPanel).getByLabelText("Sender number"), "+61400001111");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.smtp2go_api_key).toBeUndefined();
  });

  it("SMS save with twilio: omits auth_token from payload when field is empty", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true, sms_provider: "twilio",
          smtp2go_api_key_is_set: false, smtp2go_sender_number: "",
          twilio_account_sid: "AC123", twilio_auth_token_is_set: true, twilio_from_number: "+61400001111",
          clicksend_username: "", clicksend_api_key_is_set: false, clicksend_from_number: "",
          webhook_url: "", webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const smsPanel = screen.getByRole("tabpanel", { name: /SMS/i });
    await user.click(within(smsPanel).getByLabelText("Enable SMS OTP"));
    await user.selectOptions(within(smsPanel).getByRole("combobox", { name: "Provider" }), "twilio");
    await user.type(within(smsPanel).getByLabelText("Account SID"), "AC123");
    // Leave auth token empty — tests the falsy branch
    await user.type(within(smsPanel).getByLabelText("From number"), "+61400001111");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.twilio_auth_token).toBeUndefined();
  });

  it("SMS save with clicksend: omits api_key from payload when field is empty", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true, sms_provider: "clicksend",
          smtp2go_api_key_is_set: false, smtp2go_sender_number: "",
          twilio_account_sid: "", twilio_auth_token_is_set: false, twilio_from_number: "",
          clicksend_username: "user@example.com", clicksend_api_key_is_set: false, clicksend_from_number: "+61400002222",
          webhook_url: "", webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const smsPanel = screen.getByRole("tabpanel", { name: /SMS/i });
    await user.click(within(smsPanel).getByLabelText("Enable SMS OTP"));
    await user.selectOptions(within(smsPanel).getByRole("combobox", { name: "Provider" }), "clicksend");
    await user.type(within(smsPanel).getByLabelText("Username"), "user@example.com");
    // Leave API key empty — tests the falsy branch
    await user.type(within(smsPanel).getByLabelText("From number"), "+61400002222");
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.clicksend_api_key).toBeUndefined();
  });

  it("SMS save with webhook: omits secret from payload when field is empty", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/sms`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          sms_enabled: true, sms_provider: "webhook",
          smtp2go_api_key_is_set: false, smtp2go_sender_number: "",
          twilio_account_sid: "", twilio_auth_token_is_set: false, twilio_from_number: "",
          clicksend_username: "", clicksend_api_key_is_set: false, clicksend_from_number: "",
          webhook_url: "https://example.com/sms", webhook_secret_is_set: false,
        });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const smsPanel = screen.getByRole("tabpanel", { name: /SMS/i });
    await user.click(within(smsPanel).getByLabelText("Enable SMS OTP"));
    await user.selectOptions(within(smsPanel).getByRole("combobox", { name: "Provider" }), "webhook");
    await user.type(within(smsPanel).getByLabelText("Webhook URL"), "https://example.com/sms");
    // Leave secret empty — tests the falsy branch
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody?.webhook_secret).toBeUndefined();
  });

  it("SMS save error uses fallback message for non-Error thrown value", async () => {
    vi.spyOn(configApi, "updateSmsConfig").mockRejectedValueOnce("string-error");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByTestId("sms-save-btn"));
    await waitFor(() => {
      expect(screen.getByText("Failed to save SMS settings.")).toBeInTheDocument();
    });
  });

  it("Send test SMS error uses fallback message for non-Error thrown value", async () => {
    vi.spyOn(configApi, "testSmsConfig").mockRejectedValueOnce("string-error");
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.click(screen.getByLabelText("Enable SMS OTP"));
    await user.type(screen.getByLabelText("Phone number"), "+61412345678");
    await user.click(screen.getByRole("button", { name: "Send test SMS" }));
    await waitFor(() => {
      expect(screen.getByText("Test SMS failed.")).toBeInTheDocument();
    });
  });

  it("provider select renders with null provider (shows empty string value)", async () => {
    // Fixture default: sms_provider is null — select should show empty option
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    const select = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("provider select: selecting empty option resets provider to null", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("tab", { name: "SMS" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "SMS" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "twilio");
    // Now select the blank option again — should reset to null
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "");
    const select = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    // Twilio fields should be gone
    expect(screen.queryByLabelText("Account SID")).not.toBeInTheDocument();
  });
});
