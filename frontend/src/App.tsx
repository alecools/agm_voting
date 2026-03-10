import React from "react";
import { Routes, Route } from "react-router-dom";
import { BuildingSelectPage } from "./pages/vote/BuildingSelectPage";
import { AuthPage } from "./pages/vote/AuthPage";
import { VotingPage } from "./pages/vote/VotingPage";
import { ConfirmationPage } from "./pages/vote/ConfirmationPage";
import AdminRoutes from "./routes/AdminRoutes";
import AGMSummaryPage from "./pages/AGMSummaryPage";

export default function App() {
  return (
    <Routes>
      {/* Lot owner voting routes */}
      <Route path="/" element={<BuildingSelectPage />} />
      <Route path="/vote/:agmId/auth" element={<AuthPage />} />
      <Route path="/vote/:agmId/voting" element={<VotingPage />} />
      <Route path="/vote/:agmId/confirmation" element={<ConfirmationPage />} />

      {/* Public AGM summary page */}
      <Route path="/agm/:agmId/summary" element={<AGMSummaryPage />} />

      {/* Admin routes added by Phase 5 */}
      <Route path="/admin/*" element={<AdminRoutes />} />
    </Routes>
  );
}
