import React from "react";

export function ClosedBanner() {
  return (
    <div
      role="alert"
      style={{
        background: "#fbe9e7",
        border: "1px solid #d32f2f",
        borderRadius: "8px",
        padding: "16px",
        color: "#d32f2f",
        fontWeight: "bold",
        marginBottom: "16px",
      }}
    >
      Voting has closed for this meeting.
    </div>
  );
}
