import React, { Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { BuildingSelectPage } from "./pages/vote/BuildingSelectPage";
import { AuthPage } from "./pages/vote/AuthPage";
import { VotingPage } from "./pages/vote/VotingPage";
import { ConfirmationPage } from "./pages/vote/ConfirmationPage";
import { VoterShell } from "./components/vote/VoterShell";
import GeneralMeetingSummaryPage from "./pages/GeneralMeetingSummaryPage";
import { BrandingProvider } from "./context/BrandingContext";

// Admin routes are lazily loaded so the voter-flow bundle stays lean.
// Admin code is only downloaded when a user navigates to /admin.
const AdminRoutes = React.lazy(() => import("./routes/AdminRoutes"));

export default function App() {
  return (
    <BrandingProvider>
      <Routes>
        {/* Lot owner voting routes — wrapped in shared header shell */}
        <Route element={<VoterShell />}>
          <Route path="/" element={<BuildingSelectPage />} />
          <Route path="/vote/:meetingId/auth" element={<AuthPage />} />
          <Route path="/vote/:meetingId/voting" element={<VotingPage />} />
          <Route path="/vote/:meetingId/confirmation" element={<ConfirmationPage />} />
        </Route>

        {/* Public General Meeting summary page */}
        <Route path="/general-meeting/:meetingId/summary" element={<GeneralMeetingSummaryPage />} />

        {/* Admin routes — loaded on demand */}
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<div className="loading-spinner" />}>
              <AdminRoutes />
            </Suspense>
          }
        />
      </Routes>
      <Analytics />
      <SpeedInsights />
    </BrandingProvider>
  );
}
