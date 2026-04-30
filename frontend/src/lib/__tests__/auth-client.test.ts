import { describe, it, expect, vi } from "vitest";

// Mock better-auth/react so the test does not make real network calls.
// createAuthClient is called at module load time (top-level export), so the
// mock must be in place before the module under test is imported.
const { mockCreateAuthClient } = vi.hoisted(() => ({
  mockCreateAuthClient: vi.fn(() => ({ signIn: {}, signOut: vi.fn(), useSession: vi.fn() })),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: mockCreateAuthClient,
}));

describe("auth-client", () => {
  it("calls createAuthClient once with a baseURL option", async () => {
    // Import the module under test after mocks are in place.
    const { authClient } = await import("../auth-client");

    // createAuthClient is called at module load time with the baseURL option.
    // In the test environment VITE_NEON_AUTH_BASE_URL is undefined (no build-time
    // substitution), so we only assert the key is present, not its value.
    expect(mockCreateAuthClient).toHaveBeenCalledOnce();
    const [callArg] = mockCreateAuthClient.mock.calls[0] as [{ baseURL: unknown }][];
    expect(callArg).toHaveProperty("baseURL");
    expect(authClient).toBeDefined();
  });

  it("exports an authClient object with signIn, signOut, and useSession", async () => {
    const { authClient } = await import("../auth-client");

    expect(authClient).toHaveProperty("signIn");
    expect(authClient).toHaveProperty("signOut");
    expect(authClient).toHaveProperty("useSession");
  });
});
