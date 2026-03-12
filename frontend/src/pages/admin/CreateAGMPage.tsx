import React from "react";
import { useNavigate } from "react-router-dom";
import CreateAGMForm from "../../components/admin/CreateAGMForm";

export default function CreateAGMPage() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" className="btn btn--ghost back-btn" onClick={() => navigate("/admin/agms")}>
        ← Back
      </button>
      <h1>Create AGM</h1>
      <CreateAGMForm />
    </div>
  );
}
