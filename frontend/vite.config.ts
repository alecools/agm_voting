import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import compression from "vite-plugin-compression";

export default defineConfig({
  plugins: [
    react(),
    compression({ algorithm: "brotliCompress", ext: ".br" }),
    compression({ algorithm: "gzip", ext: ".gz" }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          // xlsx is NOT listed here — it is pulled in only via dynamic imports
          // inside parseMotionsExcel.ts, so it will only be downloaded by admins.
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/api/voter.ts",
        "src/api/client.ts",
        "src/components/vote/**/*.tsx",
        "src/hooks/useServerTime.ts",
        "src/hooks/useCountdown.ts",
        "src/pages/vote/**/*.tsx",
        "src/routes/VoteRoutes.tsx",
        "src/App.tsx",
        // Admin files (Phase 5) — included for joint coverage tracking
        "src/api/admin.ts",
        "src/components/admin/**/*.tsx",
        "src/pages/admin/**/*.tsx",
        "src/routes/AdminRoutes.tsx",
        // Phase B utilities
        "src/utils/parseMotionsExcel.ts",
        // Code quality: shared dateTime utility
        "src/utils/dateTime.ts",
        // Phase D public summary
        "src/api/public.ts",
        "src/pages/GeneralMeetingSummaryPage.tsx",
        // Tenant branding
        "src/api/config.ts",
        "src/context/BrandingContext.tsx",
      ],
      thresholds: {
        // Per-file thresholds for Phase 4 vote files
        "src/api/voter.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/api/client.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/hooks/useServerTime.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/hooks/useCountdown.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/App.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/routes/VoteRoutes.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/utils/parseMotionsExcel.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/utils/dateTime.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/api/public.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/pages/GeneralMeetingSummaryPage.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        // Tenant branding
        "src/api/config.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/context/BrandingContext.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/pages/admin/SettingsPage.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        // Pagination feature
        "src/api/admin.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/components/admin/Pagination.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/pages/admin/BuildingsPage.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/pages/admin/GeneralMeetingListPage.tsx": { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
