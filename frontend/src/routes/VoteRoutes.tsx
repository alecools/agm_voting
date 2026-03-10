import React from "react";
import { Route, Routes } from "react-router-dom";
import { BuildingSelectPage } from "../pages/vote/BuildingSelectPage";
import { AuthPage } from "../pages/vote/AuthPage";
import { VotingPage } from "../pages/vote/VotingPage";
import { ConfirmationPage } from "../pages/vote/ConfirmationPage";

export function VoteRoutes() {
  return (
    <Routes>
      <Route path="/" element={<BuildingSelectPage />} />
      <Route path="/vote/:agmId/auth" element={<AuthPage />} />
      <Route path="/vote/:agmId/voting" element={<VotingPage />} />
      <Route path="/vote/:agmId/confirmation" element={<ConfirmationPage />} />
    </Routes>
  );
}
