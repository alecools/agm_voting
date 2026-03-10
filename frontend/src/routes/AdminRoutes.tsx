import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AdminLayout from "../pages/admin/AdminLayout";
import BuildingsPage from "../pages/admin/BuildingsPage";
import BuildingDetailPage from "../pages/admin/BuildingDetailPage";
import AGMListPage from "../pages/admin/AGMListPage";
import AGMDetailPage from "../pages/admin/AGMDetailPage";
import CreateAGMPage from "../pages/admin/CreateAGMPage";

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="buildings" replace />} />
        <Route path="buildings" element={<BuildingsPage />} />
        <Route path="buildings/:buildingId" element={<BuildingDetailPage />} />
        <Route path="agms" element={<AGMListPage />} />
        <Route path="agms/new" element={<CreateAGMPage />} />
        <Route path="agms/:agmId" element={<AGMDetailPage />} />
      </Route>
    </Routes>
  );
}
