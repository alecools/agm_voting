import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client for admin authentication.
 *
 * All requests go through the FastAPI auth proxy at /api/auth so they are
 * same-origin (no CORS) and the proxy can translate paths that differ between
 * the Better Auth SDK and Neon Auth's actual endpoints (e.g. forget-password
 * → request-password-reset).
 *
 * Better Auth requires a full absolute URL for baseURL, so we derive it from
 * window.location.origin at runtime.  The SSR guard keeps the module safe if
 * Vite is ever used in SSR mode (no window available at build time).
 */
const baseURL =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/auth`
    : "/api/auth";

export const authClient = createAuthClient({ baseURL });

/**
 * Change the current admin's password.
 *
 * `changePassword` is available on the Better Auth client but is not part of
 * the TypeScript interface exported by `createAuthClient`. This wrapper
 * provides a typed entry point without resorting to `as unknown as` casts at
 * the call site.
 */
export async function changePassword(opts: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions: boolean;
}): Promise<{ error?: { message?: string } | null }> {
  return (
    authClient as unknown as {
      changePassword: (
        opts: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }
      ) => Promise<{ error?: { message?: string } | null }>;
    }
  ).changePassword(opts);
}
