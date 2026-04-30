import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client for admin authentication.
 *
 * VITE_NEON_AUTH_BASE_URL is injected by Vite at build time from the env var.
 * In development it defaults to the local backend URL.  In production (Vercel)
 * it is set as a Vercel env var scoped to the deployment.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_NEON_AUTH_BASE_URL as string | undefined,
});
