import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client for admin authentication.
 *
 * All requests go through the FastAPI auth proxy at /api/auth so they are
 * same-origin (no CORS) and the proxy can translate paths that differ between
 * the Better Auth SDK and Neon Auth's actual endpoints (e.g. forget-password
 * → request-password-reset).
 */
export const authClient = createAuthClient({
  baseURL: "/api/auth",
});
