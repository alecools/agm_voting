import React from "react";
import type { AGMOut } from "../../api/voter";

function formatLocalDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

interface AGMListItemProps {
  agm: AGMOut;
  onEnterVoting: (agmId: string) => void;
  onViewSubmission: (agmId: string) => void;
}

export function AGMListItem({ agm, onEnterVoting, onViewSubmission }: AGMListItemProps) {
  return (
    <div data-testid={`agm-item-${agm.id}`}>
      <h3>{agm.title}</h3>
      <p>
        <span>Meeting: </span>
        <span>{formatLocalDateTime(agm.meeting_at)}</span>
      </p>
      <p>
        <span>Voting closes: </span>
        <span>{formatLocalDateTime(agm.voting_closes_at)}</span>
      </p>
      <span
        data-testid="status-badge"
        style={{
          display: "inline-block",
          padding: "2px 8px",
          background: agm.status === "open" ? "#4caf50" : "#9e9e9e",
          color: "#fff",
          borderRadius: "4px",
        }}
      >
        {agm.status === "open" ? "Open" : "Closed"}
      </span>
      {agm.status === "open" ? (
        <button onClick={() => onEnterVoting(agm.id)}>Enter Voting</button>
      ) : (
        <button onClick={() => onViewSubmission(agm.id)}>View My Submission</button>
      )}
    </div>
  );
}
