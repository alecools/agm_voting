import React, { Suspense, useEffect } from "react";
import { Routes, Route, useParams, useNavigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { BuildingSelectPage } from "./pages/vote/BuildingSelectPage";
import { AuthPage } from "./pages/vote/AuthPage";
import { VotingPage } from "./pages/vote/VotingPage";
import { ConfirmationPage } from "./pages/vote/ConfirmationPage";
import { VoterShell } from "./components/vote/VoterShell";
import GeneralMeetingSummaryPage from "./pages/GeneralMeetingSummaryPage";
import { BrandingProvider } from "./context/BrandingContext";
import AdminErrorBoundary from "./components/admin/AdminErrorBoundary";

// Admin routes are lazily loaded so the voter-flow bundle stays lean.
// Admin code is only downloaded when a user navigates to /admin.
const AdminRoutes = React.lazy(() => import("./routes/AdminRoutes"));

function VoteMeetingRedirect() {
  const { meetingId } = useParams<{ meetingId: string }>();
  // RR4-38: useNavigate() is called unconditionally at the top level of the component,
  // not inside an effect, callback, or conditional — this is correct per Rules of Hooks.
  const navigate = useNavigate();
  useEffect(() => {
    navigate(`/vote/${meetingId}/auth`, { replace: true });
  }, [meetingId, navigate]);
  return null;
}

export default function App() {
  return (
    <BrandingProvider>
      <Routes>
        {/* Lot owner voting routes — wrapped in shared header shell */}
        <Route element={<VoterShell />}>
          <Route path="/" element={<BuildingSelectPage />} />
          <Route path="/vote/:meetingId" element={<VoteMeetingRedirect />} />
          <Route path="/vote/:meetingId/auth" element={<AuthPage />} />
          <Route path="/vote/:meetingId/voting" element={<VotingPage />} />
          <Route path="/vote/:meetingId/confirmation" element={<ConfirmationPage />} />
        </Route>

        {/* Public General Meeting summary page */}
        <Route path="/general-meeting/:meetingId/summary" element={<GeneralMeetingSummaryPage />} />

        {/* Admin routes — loaded on demand; wrapped in ErrorBoundary (RR3-26) */}
        <Route
          path="/admin/*"
          element={
            <AdminErrorBoundary>
              <Suspense fallback={<div className="loading-spinner" />}>
                <AdminRoutes />
              </Suspense>
            </AdminErrorBoundary>
          }
        />
      </Routes>
      <Analytics />
      <SpeedInsights />
    </BrandingProvider>
  );
}
