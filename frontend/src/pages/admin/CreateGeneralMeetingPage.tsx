import React from "react";
import { useNavigate } from "react-router-dom";
import CreateGeneralMeetingForm from "../../components/admin/CreateGeneralMeetingForm";

export default function CreateGeneralMeetingPage() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/admin/general-meetings")}>
        ← Back
      </button>
      <h1>Create General Meeting</h1>
      <CreateGeneralMeetingForm />
    </div>
  );
}
