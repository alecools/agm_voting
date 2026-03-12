import React from "react";
import { Routes, Route } from "react-router-dom";
import { BuildingSelectPage } from "./pages/vote/BuildingSelectPage";
import { AuthPage } from "./pages/vote/AuthPage";
import { LotSelectionPage } from "./pages/vote/LotSelectionPage";
import { VotingPage } from "./pages/vote/VotingPage";
import { ConfirmationPage } from "./pages/vote/ConfirmationPage";
import { VoterShell } from "./components/vote/VoterShell";
import AdminRoutes from "./routes/AdminRoutes";
import GeneralMeetingSummaryPage from "./pages/GeneralMeetingSummaryPage";

export default function App() {
  return (
    <Routes>
      {/* Lot owner voting routes — wrapped in shared header shell */}
      <Route element={<VoterShell />}>
        <Route path="/" element={<BuildingSelectPage />} />
        <Route path="/vote/:meetingId/auth" element={<AuthPage />} />
        <Route path="/vote/:meetingId/lot-selection" element={<LotSelectionPage />} />
        <Route path="/vote/:meetingId/voting" element={<VotingPage />} />
        <Route path="/vote/:meetingId/confirmation" element={<ConfirmationPage />} />
      </Route>

      {/* Public General Meeting summary page */}
      <Route path="/general-meeting/:meetingId/summary" element={<GeneralMeetingSummaryPage />} />

      {/* Admin routes */}
      <Route path="/admin/*" element={<AdminRoutes />} />
    </Routes>
  );
}
