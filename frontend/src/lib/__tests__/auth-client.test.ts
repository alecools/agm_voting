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
  it("calls createAuthClient once with baseURL derived from window.location.origin", async () => {
    // jsdom sets window.location.origin to "http://localhost:3000" in this
    // project's test environment.  The module under test reads
    // window.location.origin at load time, so this assertion verifies the SSR
    // guard takes the browser branch and builds a correct absolute URL rather
    // than leaving it as a relative path.
    const { authClient } = await import("../auth-client");

    expect(mockCreateAuthClient).toHaveBeenCalledOnce();
    const [callArg] = mockCreateAuthClient.mock.calls[0] as [{ baseURL: unknown }][];
    expect(callArg).toHaveProperty("baseURL", `${window.location.origin}/api/auth`);
    expect(authClient).toBeDefined();
  });

  it("exports an authClient object with signIn, signOut, and useSession", async () => {
    const { authClient } = await import("../auth-client");

    expect(authClient).toHaveProperty("signIn");
    expect(authClient).toHaveProperty("signOut");
    expect(authClient).toHaveProperty("useSession");
  });
});
