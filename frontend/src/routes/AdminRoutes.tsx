import { Routes, Route, Navigate } from "react-router-dom";
import AdminLayout from "../pages/admin/AdminLayout";
import AdminLoginPage from "../pages/admin/AdminLoginPage";
import BuildingsPage from "../pages/admin/BuildingsPage";
import BuildingDetailPage from "../pages/admin/BuildingDetailPage";
import GeneralMeetingListPage from "../pages/admin/GeneralMeetingListPage";
import GeneralMeetingDetailPage from "../pages/admin/GeneralMeetingDetailPage";
import CreateGeneralMeetingPage from "../pages/admin/CreateGeneralMeetingPage";
import SettingsPage from "../pages/admin/SettingsPage";
import RequireAdminAuth from "../components/admin/RequireAdminAuth";

export default function AdminRoutes() {
  return (
    <Routes>
      <Route path="login" element={<AdminLoginPage />} />
      <Route
        element={
          <RequireAdminAuth>
            <AdminLayout />
          </RequireAdminAuth>
        }
      >
        <Route index element={<Navigate to="buildings" replace />} />
        <Route path="buildings" element={<BuildingsPage />} />
        <Route path="buildings/:buildingId" element={<BuildingDetailPage />} />
        <Route path="general-meetings" element={<GeneralMeetingListPage />} />
        <Route path="general-meetings/new" element={<CreateGeneralMeetingPage />} />
        <Route path="general-meetings/:meetingId" element={<GeneralMeetingDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
